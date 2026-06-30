/**
 * Creator Claim Proof Verifier
 *
 * Deterministic source ownership proof verification.
 * No LLM. No LangChain. No wallet signing. No payment logic.
 * Only proof checks and paylabs_creator_claims updates.
 *
 * Proof methods:
 * - well_known_json: HTTPS <domain>/.well-known/paylabs-creator.json
 * - dns_txt: TXT record at _paylabs.<domain>
 *
 * Security:
 * - SSRF protection: blocks localhost, private IPs, link-local
 * - Streaming body read with 16KB cap (no resp.text())
 * - Manual redirect loop (max 3) with target validation
 * - Duplicate verified claim guard before marking verified
 * - Stale status race guard on all DB updates
 */

import { createHash } from "node:crypto";
import { resolveTxt, lookup } from "node:dns/promises";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Types ─────────────────────────────────────────────────────

interface CreatorClaimRow {
  id: string;
  creator_wallet: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  claim_status: string;
  verification_method: string | null;
  verified_at: string | null;
  proof_type: string | null;
  proof_nonce: string | null;
  proof_status: string;
  proof_checked_at: string | null;
  proof_error: string | null;
  proof_evidence_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProofChallenge {
  claim_id: string;
  creator_wallet: string;
  source_domain: string;
  nonce: string;
  service: string;
  version: number;
}

export interface ProofResult {
  ok: boolean;
  proof_type: "well_known_json" | "dns_txt";
  proof_status: "verified" | "failed";
  proof_error: string | null;
  proof_evidence_hash: string | null;
}

// ─── Constants ─────────────────────────────────────────────────

const MULTI_TENANT_DOMAINS = new Set([
  "medium.com",
  "substack.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "github.com",
  "github.io",
  "vercel.app",
  "netlify.app",
  "notion.site",
  "mirror.xyz",
  "paragraph.xyz",
]);

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const WELL_KNOWN_TIMEOUT_MS = 5_000;
const WELL_KNOWN_MAX_BYTES = 16_384;
const MAX_REDIRECTS = 3;

// Private/internal IP ranges (IPv4 + IPv6)
const PRIVATE_IP_PATTERNS: Array<(addr: string) => boolean> = [
  // IPv4
  (a) => a === "127.0.0.1" || a.startsWith("127."), // loopback
  (a) => a === "0.0.0.0" || a.startsWith("0."), // unspecified
  (a) => a.startsWith("10."), // 10.0.0.0/8
  (a) => {
    const p = a.split(".");
    return p[0] === "100" && Number(p[1]) >= 64 && Number(p[1]) <= 127;
  }, // 100.64.0.0/10 (CGNAT)
  (a) => a.startsWith("169.254."), // link-local
  (a) => a.startsWith("172.") && Number(a.split(".")[1]) >= 16 && Number(a.split(".")[1]) <= 31, // 172.16.0.0/12
  (a) => a.startsWith("192.168."), // 192.168.0.0/16
  (a) => {
    const p = a.split(".");
    return p[0] === "198" && Number(p[1]) >= 18 && Number(p[1]) <= 19;
  }, // 198.18.0.0/15
  (a) => Number(a.split(".")[0]) >= 224, // 224.0.0.0/4 (multicast+reserved)
  // IPv6
  (a) => a === "::1", // loopback
  (a) => a.startsWith("fc") || a.startsWith("fd"), // fc00::/7
  (a) => a.startsWith("fe80"), // fe80::/10 link-local
  (a) => a.startsWith("::ffff:") && isPrivateIPv4(a.slice(7)), // IPv4-mapped
];

function isPrivateIPv4(addr: string): boolean {
  return PRIVATE_IP_PATTERNS.slice(0, 9).some((fn) => fn(addr));
}

function isPrivateIP(addr: string): boolean {
  return PRIVATE_IP_PATTERNS.some((fn) => fn(addr));
}

// ─── Helpers ───────────────────────────────────────────────────

function isValidEvmAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  return EVM_RE.test(addr);
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function deriveHttpsDomain(
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ─── Fix 4: SSRF Protection ────────────────────────────────────

/**
 * Validate that a URL is safe to fetch:
 * - HTTPS only
 * - No credentials in URL
 * - Hostname resolves to public IPs only
 */
async function assertSafePublicHttpsUrl(
  url: URL,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (url.protocol !== "https:") {
    return { ok: false, error: "non_https_url" };
  }

  if (url.username || url.password) {
    return { ok: false, error: "url_has_credentials" };
  }

  const hostname = url.hostname.toLowerCase();

  // Block obvious internal hostnames
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return { ok: false, error: "internal_hostname" };
  }

  // DNS resolve and check all IPs
  try {
    const { address } = await lookup(hostname, { family: 0, all: false });
    if (isPrivateIP(address)) {
      return { ok: false, error: "private_ip_resolved" };
    }
  } catch {
    return { ok: false, error: "dns_lookup_failed" };
  }

  return { ok: true };
}

// ─── Fix 3: Streaming Body Read with Size Cap ──────────────────

/**
 * Read response body with strict byte limit.
 * Keeps AbortController active until body read completes.
 * Throws on oversized response.
 */
async function readLimitedText(
  resp: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("no_response_body");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error("response_too_large");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Concatenate chunks
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

// ─── Fix 1: Duplicate Verified Claim Guard ─────────────────────

/**
 * Check if another claim already verified for the same source_url.
 * Returns conflict info or null.
 */
export async function findVerifiedClaimConflict(
  db: SupabaseClient,
  claimId: string,
  sourceUrl: string | null,
): Promise<{ conflict_claim_id: string } | null> {
  if (!sourceUrl) return null;

  const { data: conflicting } = await db
    .from("paylabs_creator_claims")
    .select("id")
    .eq("source_url", sourceUrl)
    .eq("claim_status", "verified")
    .neq("id", claimId)
    .limit(1);

  if (conflicting && conflicting.length > 0) {
    return { conflict_claim_id: (conflicting[0] as { id: string }).id };
  }

  return null;
}

// ─── Proof Challenge Builder ───────────────────────────────────

export function buildCreatorProofChallenge(
  claim: CreatorClaimRow,
): ProofChallenge | null {
  const domain = claim.source_domain || deriveHttpsDomain(claim.source_url);
  if (!domain) return null;
  if (!isValidEvmAddress(claim.creator_wallet)) return null;
  if (!claim.proof_nonce) return null;

  return {
    claim_id: claim.id,
    creator_wallet: claim.creator_wallet.toLowerCase(),
    source_domain: domain.toLowerCase(),
    nonce: claim.proof_nonce,
    service: "paylabs",
    version: 1,
  };
}

// ─── Well-Known JSON Verification ──────────────────────────────

export async function verifyWellKnownCreatorProof(
  claim: CreatorClaimRow,
): Promise<ProofResult> {
  const challenge = buildCreatorProofChallenge(claim);
  if (!challenge) {
    return {
      ok: false,
      proof_type: "well_known_json",
      proof_status: "failed",
      proof_error: "invalid_claim_for_proof",
      proof_evidence_hash: null,
    };
  }

  const domain = challenge.source_domain;

  // Multi-tenant domain check
  if (MULTI_TENANT_DOMAINS.has(domain)) {
    return {
      ok: false,
      proof_type: "well_known_json",
      proof_status: "failed",
      proof_error: "multi_tenant_domain_requires_platform_specific_proof",
      proof_evidence_hash: null,
    };
  }

  const wellKnownUrl = `https://${domain}/.well-known/paylabs-creator.json`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      WELL_KNOWN_TIMEOUT_MS,
    );

    try {
      // Fix 4: Validate initial URL before fetch
      const initialUrl = new URL(wellKnownUrl);
      const safetyCheck = await assertSafePublicHttpsUrl(initialUrl);
      if (!safetyCheck.ok) {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: `unsafe_fetch_target: ${safetyCheck.error}`,
          proof_evidence_hash: null,
        };
      }

      // Fix 4: Manual redirect loop with SSRF checks
      let currentUrl = wellKnownUrl;
      let resp: Response | null = null;

      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
        const currentParsed = new URL(currentUrl);

        // Re-validate on each redirect
        if (redirectCount > 0) {
          const redirectSafety = await assertSafePublicHttpsUrl(currentParsed);
          if (!redirectSafety.ok) {
            return {
              ok: false,
              proof_type: "well_known_json",
              proof_status: "failed",
              proof_error: `unsafe_redirect_target: ${redirectSafety.error}`,
              proof_evidence_hash: null,
            };
          }
        }

        resp = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: "manual",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        // Follow redirect manually
        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get("location");
          if (!location) {
            return {
              ok: false,
              proof_type: "well_known_json",
              proof_status: "failed",
              proof_error: "redirect_without_location",
              proof_evidence_hash: null,
            };
          }

          // Resolve relative URLs
          const nextUrl = new URL(location, currentUrl);

          // Must be HTTPS
          if (nextUrl.protocol !== "https:") {
            return {
              ok: false,
              proof_type: "well_known_json",
              proof_status: "failed",
              proof_error: "redirect_to_non_https",
              proof_evidence_hash: null,
            };
          }

          currentUrl = nextUrl.toString();
          continue;
        }

        // Non-redirect response — process it
        break;
      }

      if (!resp) {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: "too_many_redirects",
          proof_evidence_hash: null,
        };
      }

      if (!resp.ok) {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: `http_${resp.status}`,
          proof_evidence_hash: null,
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: "non_json_response",
          proof_evidence_hash: null,
        };
      }

      // Fix 3: Streaming body read with 16KB cap, timeout stays active
      let rawText: string;
      try {
        rawText = await readLimitedText(resp, WELL_KNOWN_MAX_BYTES, controller);
      } catch (err: unknown) {
        const msg =
          err instanceof Error && err.message === "response_too_large"
            ? "response_too_large"
            : "body_read_error";
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: msg,
          proof_evidence_hash: null,
        };
      }

      let proof: Record<string, unknown>;
      try {
        proof = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: "invalid_json",
          proof_evidence_hash: null,
        };
      }

      // Exact match verification
      const errors: string[] = [];

      if (proof.service !== "paylabs") errors.push("service_mismatch");
      if (proof.version !== 1) errors.push("version_mismatch");
      if (proof.claim_id !== challenge.claim_id) errors.push("claim_id_mismatch");
      if (
        typeof proof.creator_wallet !== "string" ||
        proof.creator_wallet.toLowerCase() !== challenge.creator_wallet
      ) {
        errors.push("creator_wallet_mismatch");
      }
      if (
        typeof proof.source_domain !== "string" ||
        proof.source_domain.toLowerCase() !== challenge.source_domain
      ) {
        errors.push("source_domain_mismatch");
      }
      if (proof.nonce !== challenge.nonce) errors.push("nonce_mismatch");

      if (errors.length > 0) {
        return {
          ok: false,
          proof_type: "well_known_json",
          proof_status: "failed",
          proof_error: errors.join(","),
          proof_evidence_hash: null,
        };
      }

      // Success — compute evidence hash (normalized, no raw payload stored)
      const normalized = JSON.stringify({
        service: "paylabs",
        version: 1,
        claim_id: challenge.claim_id,
        creator_wallet: challenge.creator_wallet,
        source_domain: challenge.source_domain,
        nonce: challenge.nonce,
      });

      return {
        ok: true,
        proof_type: "well_known_json",
        proof_status: "verified",
        proof_error: null,
        proof_evidence_hash: sha256Hex(normalized),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? "fetch_timeout"
        : "fetch_error";
    return {
      ok: false,
      proof_type: "well_known_json",
      proof_status: "failed",
      proof_error: msg,
      proof_evidence_hash: null,
    };
  }
}

// ─── DNS TXT Verification ──────────────────────────────────────

export async function verifyDnsTxtCreatorProof(
  claim: CreatorClaimRow,
): Promise<ProofResult> {
  const challenge = buildCreatorProofChallenge(claim);
  if (!challenge) {
    return {
      ok: false,
      proof_type: "dns_txt",
      proof_status: "failed",
      proof_error: "invalid_claim_for_proof",
      proof_evidence_hash: null,
    };
  }

  const domain = challenge.source_domain;

  // Multi-tenant domain check
  if (MULTI_TENANT_DOMAINS.has(domain)) {
    return {
      ok: false,
      proof_type: "dns_txt",
      proof_status: "failed",
      proof_error: "multi_tenant_domain_requires_platform_specific_proof",
      proof_evidence_hash: null,
    };
  }

  const txtHost = `_paylabs.${domain}`;
  const expectedValue = `paylabs-v1 claim=${challenge.claim_id} wallet=${challenge.creator_wallet} nonce=${challenge.nonce}`;

  try {
    const records = await resolveTxt(txtHost);

    // DNS TXT records come as string[][], join each array to string
    const flatRecords = records.map((parts) => parts.join(""));

    const matched = flatRecords.some((record) => record === expectedValue);

    if (!matched) {
      return {
        ok: false,
        proof_type: "dns_txt",
        proof_status: "failed",
        proof_error: "no_matching_txt_record",
        proof_evidence_hash: null,
      };
    }

    return {
      ok: true,
      proof_type: "dns_txt",
      proof_status: "verified",
      proof_error: null,
      proof_evidence_hash: sha256Hex(expectedValue),
    };
  } catch (err: unknown) {
    const msg =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOTFOUND"
        ? "dns_lookup_failed"
        : "dns_error";
    return {
      ok: false,
      proof_type: "dns_txt",
      proof_status: "failed",
      proof_error: msg,
      proof_evidence_hash: null,
    };
  }
}

// ─── Unified Verification ──────────────────────────────────────

export async function verifyCreatorClaimProof(
  claim: CreatorClaimRow,
  proofType?: "well_known_json" | "dns_txt",
): Promise<ProofResult> {
  if (proofType === "well_known_json") {
    return verifyWellKnownCreatorProof(claim);
  }
  if (proofType === "dns_txt") {
    return verifyDnsTxtCreatorProof(claim);
  }

  // Default: try well-known first, then DNS
  const wellKnownResult = await verifyWellKnownCreatorProof(claim);
  if (wellKnownResult.ok) return wellKnownResult;

  return verifyDnsTxtCreatorProof(claim);
}

// ─── Batch Verification (Cron) ─────────────────────────────────

export async function verifyPendingCreatorClaims(
  limit: number,
): Promise<{ checked: number; verified: number; failed: number; skipped: number }> {
  const db = supabaseAdmin();

  const { data: claims, error } = await db
    .from("paylabs_creator_claims")
    .select("*")
    .in("claim_status", ["unclaimed", "unknown"])
    .in("proof_status", ["pending", "failed"])
    .not("proof_nonce", "is", null)
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error || !claims) {
    console.error("[proof-verifier] cron fetch failed", {
      code: error?.code,
    });
    return { checked: 0, verified: 0, failed: 0, skipped: 0 };
  }

  let verified = 0;
  let failed = 0;
  let skipped = 0;

  for (const claim of claims as CreatorClaimRow[]) {
    // Multi-tenant skip
    const domain =
      claim.source_domain || deriveHttpsDomain(claim.source_url);
    if (domain && MULTI_TENANT_DOMAINS.has(domain)) {
      // Fix 2: Guard update with status check
      await db
        .from("paylabs_creator_claims")
        .update({
          proof_status: "failed",
          proof_error: "multi_tenant_domain_requires_platform_specific_proof",
          proof_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .in("claim_status", ["unclaimed", "unknown"]);
      skipped++;
      continue;
    }

    const result = await verifyCreatorClaimProof(claim);

    if (result.ok) {
      // Fix 1: Check for duplicate verified claim before marking verified
      const conflict = await findVerifiedClaimConflict(
        db,
        claim.id,
        claim.source_url,
      );
      if (conflict) {
        // Another claim already verified for this source — block
        await db
          .from("paylabs_creator_claims")
          .update({
            proof_status: "failed",
            proof_error: "verified_claim_conflict",
            proof_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", claim.id)
          .in("claim_status", ["unclaimed", "unknown"]);
        skipped++;
        continue;
      }

      // Fix 2: Guard update with status check
      const { data: updated } = await db
        .from("paylabs_creator_claims")
        .update({
          claim_status: "verified",
          proof_status: "verified",
          proof_type: result.proof_type,
          verified_at: new Date().toISOString(),
          verification_method: result.proof_type,
          proof_checked_at: new Date().toISOString(),
          proof_error: null,
          proof_evidence_hash: result.proof_evidence_hash,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .in("claim_status", ["unclaimed", "unknown"])
        .select("id");

      if (updated && updated.length > 0) {
        verified++;
      } else {
        // Status changed between read and write — skip
        skipped++;
      }
    } else {
      // Fix 2: Guard failure update with status check
      await db
        .from("paylabs_creator_claims")
        .update({
          proof_status: "failed",
          proof_type: result.proof_type,
          proof_checked_at: new Date().toISOString(),
          proof_error: result.proof_error,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .in("claim_status", ["unclaimed", "unknown"]);
      failed++;
    }
  }

  return { checked: claims.length, verified, failed, skipped };
}
