import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

// ─── Types ─────────────────────────────────────────────────────

type CreatorClaim = {
  id: string;
  creator_wallet: string;
  creator_name: string | null;
  source_url: string | null;
  source_domain: string | null;
  canonical_url: string | null;
  claim_scope: string | null;
  claim_scope_key: string | null;
  source_platform: string | null;
  claim_status: string;
  verification_method: string | null;
  proof_method: string | null;
  proof_status: string | null;
  proof_nonce: string | null;
};

// ─── Constants ─────────────────────────────────────────────────

const SAFE_CLAIM_COLUMNS =
  "id, creator_wallet, creator_name, source_url, source_domain, canonical_url, claim_scope, claim_scope_key, source_platform, claim_status, verification_method, proof_method, proof_status, proof_nonce";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024; // 64 KB — proof files are tiny
const MAX_REDIRECTS = 3;

/** Unlocked claim statuses that verification can mutate. */
const UNLOCKED_STATUSES = ["unclaimed", "unknown"];

// ─── SSRF Protection ──────────────────────────────────────────

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x7f000000, 0xff000000],   // 127.0.0.0/8
  [0x00000000, 0xff000000],   // 0.0.0.0/8
  [0x0a000000, 0xff000000],   // 10.0.0.0/8
  [0x40400000, 0xffc00000],   // 100.64.0.0/10
  [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16
  [0xac100000, 0xfff00000],   // 172.16.0.0/12
  [0xc0a80000, 0xffff0000],   // 192.168.0.0/16
  [0xc6120000, 0xfffe0000],   // 198.18.0.0/15
  [0xe0000000, 0xf0000000],   // 224.0.0.0/4
  [0xf0000000, 0xf0000000],   // 240.0.0.0/4
];

function ipv4ToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const long = ipv4ToLong(ip);
  return PRIVATE_IPV4_RANGES.some(([network, mask]) => (long & mask) === network);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback
  if (lower === "::1") return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 etc
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    if (v4.includes(".") && isPrivateIpv4(v4)) return true;
  }
  // fc00::/7 (unique local)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 (link-local)
  if (lower.startsWith("fe80")) return true;
  return false;
}

/** Check if all resolved IPs for a hostname are public. */
async function assertPublicHost(hostname: string): Promise<{ ok: boolean; error?: string }> {
  // Reject localhost patterns
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    return { ok: false, error: "proof_internal_target_blocked" };
  }

  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) {
      return { ok: false, error: "proof_internal_target_blocked" };
    }
    for (const record of records) {
      if (record.family === 4 && isPrivateIpv4(record.address)) {
        return { ok: false, error: "proof_internal_target_blocked" };
      }
      if (record.family === 6 && isPrivateIpv6(record.address)) {
        return { ok: false, error: "proof_internal_target_blocked" };
      }
    }
    return { ok: true };
  } catch {
    // DNS lookup failed — could be invalid hostname
    return { ok: false, error: "proof_fetch_failed" };
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function getWalletSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return { sid: null, walletAddress: null };
  const session = await getSession(sid);
  if (!session?.walletAddress) return { sid, walletAddress: null };
  return { sid, walletAddress: session.walletAddress.toLowerCase() };
}

// ─── Safe Fetch (timeout covers full body read, no redirect follow) ──

type FetchProofResult = { ok: boolean; status: number; body: string | null; error?: string };

/**
 * Fetch a proof URL with full SSRF protection:
 * - Timeout covers the entire request including body read
 * - No automatic redirect follow (redirect: "manual")
 * - Body size capped at MAX_BODY_BYTES
 * - No resp.text() fallback (streaming only)
 */
async function fetchProofRaw(url: string): Promise<FetchProofResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "PayLabs/0.1 Creator-Verify" },
    });

    // Handle redirects manually (up to MAX_REDIRECTS)
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };

      // Resolve relative redirect against original URL
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };
      }

      // Must stay HTTPS
      if (redirectUrl.protocol !== "https:") {
        return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };
      }

      // Validate redirect target host
      const hostCheck = await assertPublicHost(redirectUrl.hostname);
      if (!hostCheck.ok) {
        return { ok: false, status: res.status, body: null, error: hostCheck.error };
      }

      // No userinfo in redirect URL
      if (redirectUrl.username || redirectUrl.password) {
        return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };
      }

      // Recursive fetch with decrement (timeout still covers everything)
      return fetchProofRedirect(redirectUrl.toString(), MAX_REDIRECTS - 1);
    }

    if (!res.ok) {
      return { ok: false, status: res.status, body: null, error: safeHttpError(res.status) };
    }

    // Body size guard
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return { ok: false, status: res.status, body: null, error: "proof_response_too_large" };
    }

    // Read body stream with size cap (timeout still active)
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, status: res.status, body: null, error: "proof_fetch_failed" };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel();
        return { ok: false, status: res.status, body: null, error: "proof_response_too_large" };
      }
      chunks.push(value);
    }

    const body = new TextDecoder().decode(Buffer.concat(chunks));
    return { ok: true, status: res.status, body };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, status: 0, body: null, error: "proof_fetch_timeout" };
    return { ok: false, status: 0, body: null, error: "proof_fetch_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Follow a redirect with remaining budget. */
async function fetchProofRedirect(url: string, remainingRedirects: number): Promise<FetchProofResult> {
  if (remainingRedirects <= 0) return { ok: false, status: 0, body: null, error: "proof_redirect_blocked" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "PayLabs/0.1 Creator-Verify" },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };

      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };
      }

      if (redirectUrl.protocol !== "https:") return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };
      if (redirectUrl.username || redirectUrl.password) return { ok: false, status: res.status, body: null, error: "proof_redirect_blocked" };

      const hostCheck = await assertPublicHost(redirectUrl.hostname);
      if (!hostCheck.ok) return { ok: false, status: res.status, body: null, error: hostCheck.error };

      return fetchProofRedirect(redirectUrl.toString(), remainingRedirects - 1);
    }

    if (!res.ok) return { ok: false, status: res.status, body: null, error: safeHttpError(res.status) };

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return { ok: false, status: res.status, body: null, error: "proof_response_too_large" };
    }

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: res.status, body: null, error: "proof_fetch_failed" };

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel();
        return { ok: false, status: res.status, body: null, error: "proof_response_too_large" };
      }
      chunks.push(value);
    }

    const body = new TextDecoder().decode(Buffer.concat(chunks));
    return { ok: true, status: res.status, body };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort")) return { ok: false, status: 0, body: null, error: "proof_fetch_timeout" };
    return { ok: false, status: 0, body: null, error: "proof_fetch_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Map HTTP status to safe error code (no URL leaked). */
function safeHttpError(status: number): string {
  if (status === 404) return "proof_http_404";
  if (status >= 500) return "proof_http_500";
  return "proof_fetch_failed";
}

// ─── Verification Logic ───────────────────────────────────────

type VerifyResult = {
  ok: boolean;
  proof_status: "verified" | "failed";
  proof_error: string | null;
  evidence_hash: string | null;
};

async function verifyWellKnownJson(claim: CreatorClaim): Promise<VerifyResult> {
  const domain = claim.source_domain;
  if (!domain) {
    return { ok: false, proof_status: "failed", proof_error: "proof_fetch_failed", evidence_hash: null };
  }

  // SSRF: validate domain is public before fetching
  const hostCheck = await assertPublicHost(domain);
  if (!hostCheck.ok) {
    return { ok: false, proof_status: "failed", proof_error: hostCheck.error ?? "proof_internal_target_blocked", evidence_hash: null };
  }

  const wellKnownUrl = `https://${domain}/.well-known/paylabs-verify.json`;
  const fetched = await fetchProofRaw(wellKnownUrl);

  if (!fetched.ok || !fetched.body) {
    return {
      ok: false,
      proof_status: "failed",
      proof_error: fetched.error || "proof_fetch_failed",
      evidence_hash: null,
    };
  }

  const evidenceHash = sha256(fetched.body);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fetched.body);
  } catch {
    return {
      ok: false,
      proof_status: "failed",
      proof_error: "Invalid JSON in paylabs-verify.json",
      evidence_hash: evidenceHash,
    };
  }

  // Check required fields
  const wallet = typeof parsed.creator_wallet === "string" ? parsed.creator_wallet.toLowerCase() : "";
  if (!wallet) {
    return {
      ok: false,
      proof_status: "failed",
      proof_error: "creator_wallet missing from paylabs-verify.json",
      evidence_hash: evidenceHash,
    };
  }

  // Wallet must match claim
  if (wallet !== claim.creator_wallet.toLowerCase()) {
    return {
      ok: false,
      proof_status: "failed",
      proof_error: "Wallet mismatch: proof wallet does not match registered wallet",
      evidence_hash: evidenceHash,
    };
  }

  // Nonce check (optional but recommended)
  if (claim.proof_nonce) {
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
    if (nonce !== claim.proof_nonce) {
      return {
        ok: false,
        proof_status: "failed",
        proof_error: "Nonce mismatch: proof nonce does not match challenge nonce",
        evidence_hash: evidenceHash,
      };
    }
  }

  return {
    ok: true,
    proof_status: "verified",
    proof_error: null,
    evidence_hash: evidenceHash,
  };
}

/** Validate GitHub owner/repo chars: alphanumeric, hyphen, underscore, dot only. */
const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

async function verifyGithubRepoFile(claim: CreatorClaim): Promise<VerifyResult> {
  const sourceUrl = claim.source_url;
  if (!sourceUrl) {
    return { ok: false, proof_status: "failed", proof_error: "Not a GitHub URL", evidence_hash: null };
  }

  let owner: string, repo: string;
  try {
    const parsedUrl = new URL(sourceUrl);
    const host = parsedUrl.hostname.toLowerCase();
    if ((parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") || (host !== "github.com" && host !== "www.github.com")) {
      return { ok: false, proof_status: "failed", proof_error: "Not a GitHub URL", evidence_hash: null };
    }

    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("Invalid GitHub URL");
    owner = parts[0];
    repo = parts[1].replace(/\.git$/, "");
  } catch {
    return { ok: false, proof_status: "failed", proof_error: "Cannot parse GitHub owner/repo", evidence_hash: null };
  }

  // Validate owner/repo chars — no slash injection, no special chars
  if (!GITHUB_OWNER_REPO_RE.test(owner) || !GITHUB_OWNER_REPO_RE.test(repo)) {
    return { ok: false, proof_status: "failed", proof_error: "Invalid GitHub owner/repo format", evidence_hash: null };
  }

  // Try main branch first, then master
  for (const branch of ["main", "master"]) {
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${branch}/paylabs.json`;
    const fetched = await fetchProofRaw(rawUrl);

    if (!fetched.ok || !fetched.body) continue; // try next branch

    const evidenceHash = sha256(fetched.body);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fetched.body);
    } catch {
      return {
        ok: false,
        proof_status: "failed",
        proof_error: "Invalid JSON in paylabs.json",
        evidence_hash: evidenceHash,
      };
    }

    const wallet = typeof parsed.creator_wallet === "string" ? parsed.creator_wallet.toLowerCase() : "";
    if (!wallet) {
      return {
        ok: false,
        proof_status: "failed",
        proof_error: "creator_wallet missing from paylabs.json",
        evidence_hash: evidenceHash,
      };
    }

    if (wallet !== claim.creator_wallet.toLowerCase()) {
      return {
        ok: false,
        proof_status: "failed",
        proof_error: "Wallet mismatch: proof wallet does not match registered wallet",
        evidence_hash: evidenceHash,
      };
    }

    return {
      ok: true,
      proof_status: "verified",
      proof_error: null,
      evidence_hash: evidenceHash,
    };
  }

  return {
    ok: false,
    proof_status: "failed",
    proof_error: "paylabs.json not found on main or master branch",
    evidence_hash: null,
  };
}

// ─── POST ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({ error: "Connected Creator Wallet required" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { claim_id?: unknown };
  const claimId = typeof body.claim_id === "string" ? body.claim_id.trim() : "";
  if (!claimId) {
    return NextResponse.json({ error: "claim_id is required" }, { status: 400 });
  }

  const supabase = supabaseAdmin();

  // Load claim — must belong to this wallet
  const { data: claim, error: selectError } = await supabase
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("id", claimId)
    .eq("creator_wallet", walletAddress)
    .single();

  if (selectError || !claim) {
    return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  }

  const typedClaim = claim as CreatorClaim;

  // Already verified
  if (typedClaim.claim_status === "verified" && typedClaim.proof_status === "verified") {
    return NextResponse.json({
      ok: true,
      proof_status: "verified",
      message: "Claim is already verified.",
    });
  }

  // Locked statuses — cannot re-verify
  if (typedClaim.claim_status === "rejected" || typedClaim.claim_status === "revoked") {
    return NextResponse.json({
      ok: false,
      proof_status: typedClaim.proof_status,
      error: `Claim is ${typedClaim.claim_status} and cannot be re-verified.`,
    }, { status: 409 });
  }

  // Manual review — cannot auto-verify
  if (typedClaim.proof_method === "manual_review") {
    return NextResponse.json({
      ok: false,
      proof_status: "manual_required",
      message: "This claim requires manual review. Please wait for our team to verify.",
    });
  }

  // Run verification
  let result: VerifyResult;

  if (typedClaim.proof_method === "github_repo_file") {
    result = await verifyGithubRepoFile(typedClaim);
  } else if (typedClaim.proof_method === "well_known_json") {
    result = await verifyWellKnownJson(typedClaim);
  } else {
    return NextResponse.json({
      ok: false,
      proof_status: "failed",
      error: `Unknown proof method: ${typedClaim.proof_method}`,
    }, { status: 400 });
  }

  // Update claim in DB — guarded by unlocked status to prevent stale overwrites.
  const now = new Date().toISOString();
  const updateFields: Record<string, unknown> = {
    proof_status: result.proof_status,
    proof_checked_at: now,
    proof_error: result.proof_error,
    proof_evidence_hash: result.evidence_hash,
    updated_at: now,
  };

  // If proof passed, check for scope conflict before marking verified.
  if (result.ok && typedClaim.claim_scope_key) {
    const { data: conflict } = await supabase
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, claim_status")
      .eq("claim_scope_key", typedClaim.claim_scope_key)
      .eq("claim_status", "verified")
      .neq("id", claimId)
      .limit(1);

    if (conflict && conflict.length > 0) {
      return NextResponse.json({
        ok: false,
        proof_status: "failed",
        error: "This source scope is already verified by another creator wallet. Only one wallet can own a given source.",
        message: "Source already claimed by another creator.",
      }, { status: 409 });
    }

    updateFields.claim_status = "verified";
    updateFields.verified_at = now;
    updateFields.verification_method = typedClaim.proof_method;
  }

  // Guarded update: only mutate if claim is still in an unlocked status.
  // Prevents stale verification from overwriting rejected/revoked/verified claims.
  const { data: updated, error: updateError } = await supabase
    .from("paylabs_creator_claims")
    .update(updateFields)
    .eq("id", claimId)
    .in("claim_status", UNLOCKED_STATUSES)
    .select("id");

  if (sid) await refreshSession(sid);

  // Check error first — DB failures must not be mislabeled as status changes.
  if (updateError) {
    return NextResponse.json({
      ok: false,
      error: "proof_update_failed",
      message: "Failed to update claim. Please try again.",
    }, { status: 500 });
  }

  // Detect no row updated (claim_status changed between read and write)
  if (!updated || updated.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "claim_status_changed",
      message: "Claim status changed during verification. Refresh and try again.",
    }, { status: 409 });
  }

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      proof_status: "verified",
      message: "Source verified! Your creator wallet is now eligible for payouts.",
    });
  }

  return NextResponse.json({
    ok: false,
    proof_status: result.proof_status,
    error: result.proof_error,
    message: result.proof_error ?? "Verification failed. Check your proof file and try again.",
  });
}
