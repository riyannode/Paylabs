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
 */

import { createHash } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { supabaseAdmin } from "@/lib/supabase/server";

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

    const resp = await fetch(wellKnownUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    // Reject non-HTTPS redirects
    if (resp.url && !resp.url.startsWith("https://")) {
      return {
        ok: false,
        proof_type: "well_known_json",
        proof_status: "failed",
        proof_error: "redirect_to_non_https",
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

    // Check response size
    const rawText = await resp.text();
    if (new TextEncoder().encode(rawText).length > WELL_KNOWN_MAX_BYTES) {
      return {
        ok: false,
        proof_type: "well_known_json",
        proof_status: "failed",
        proof_error: "response_too_large",
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
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOTFOUND"
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
      await db
        .from("paylabs_creator_claims")
        .update({
          proof_status: "failed",
          proof_error: "multi_tenant_domain_requires_platform_specific_proof",
          proof_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id);
      skipped++;
      continue;
    }

    const result = await verifyCreatorClaimProof(claim);

    if (result.ok) {
      await db
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
        .eq("id", claim.id);
      verified++;
    } else {
      await db
        .from("paylabs_creator_claims")
        .update({
          proof_status: "failed",
          proof_type: result.proof_type,
          proof_checked_at: new Date().toISOString(),
          proof_error: result.proof_error,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id);
      failed++;
    }
  }

  return { checked: claims.length, verified, failed, skipped };
}
