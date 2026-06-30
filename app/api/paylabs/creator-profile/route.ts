import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";
import { createHash, randomBytes } from "node:crypto";

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
  claim_status: "verified" | "unclaimed" | "rejected" | "revoked" | "unknown";
  verification_method: string | null;
  proof_method: string | null;
  proof_status: string | null;
  proof_nonce: string | null;
  proof_checked_at: string | null;
  proof_error: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

// ─── Constants ─────────────────────────────────────────────────

const SAFE_CLAIM_COLUMNS =
  "id, creator_wallet, creator_name, source_url, source_domain, canonical_url, claim_scope, claim_scope_key, source_platform, claim_status, verification_method, proof_method, proof_status, proof_nonce, proof_checked_at, proof_error, verified_at, created_at, updated_at";

const LOCKED_STATUSES = new Set(["verified", "rejected", "revoked"]);

// ─── Helpers ───────────────────────────────────────────────────

function creatorProfileDbError(step: string, error: { code?: string | null }) {
  console.error("[creator-profile] safe step failed", { step, code: error.code ?? null });
  return NextResponse.json({ error: "Creator profile request failed." }, { status: 500 });
}

async function getWalletSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return { sid: null, walletAddress: null };
  const session = await getSession(sid);
  if (!session?.walletAddress) return { sid, walletAddress: null };
  return { sid, walletAddress: session.walletAddress.toLowerCase() };
}

function parseHttpsUrl(value: unknown): { url?: string; domain?: string; error?: string } {
  if (typeof value !== "string") return { error: "source_url is required" };
  const trimmed = value.trim();
  if (!trimmed) return { error: "source_url is required" };
  if (trimmed.length > 1000) return { error: "source_url must be 1000 characters or less" };
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return { error: "source_url must be an HTTPS URL" };
    return { url: url.toString(), domain: url.hostname.toLowerCase() };
  } catch {
    return { error: "source_url must be a valid HTTPS URL" };
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

// ─── Scope Detection ──────────────────────────────────────────

type ClaimScope = "exact_url" | "domain" | "host" | "github_repo" | "manual";
type SourcePlatform = "domain" | "github" | "vercel" | "netlify" | "github_pages" | "rss_publisher" | "unsupported";

function detectSourcePlatform(hostname: string): SourcePlatform {
  if (hostname === "github.com") return "github";
  if (hostname.endsWith(".github.io")) return "github_pages";
  if (hostname.endsWith(".vercel.app")) return "vercel";
  if (hostname.endsWith(".netlify.app")) return "netlify";
  return "domain";
}

function detectClaimScope(url: string, hostname: string): { scope: ClaimScope; scopeKey: string; platform: SourcePlatform } {
  const platform = detectSourcePlatform(hostname);

  // GitHub repo: https://github.com/owner/repo or deeper
  if (hostname === "github.com") {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, "");
      return {
        scope: "github_repo",
        scopeKey: `github_repo:${owner}/${repo}`,
        platform: "github",
      };
    }
  }

  // GitHub Pages: https://user.github.io/* → domain-level claim
  if (hostname.endsWith(".github.io")) {
    return {
      scope: "domain",
      scopeKey: `domain:${hostname}`,
      platform: "github_pages",
    };
  }

  // Vercel/Netlify: domain-level claim
  if (hostname.endsWith(".vercel.app") || hostname.endsWith(".netlify.app")) {
    return {
      scope: "domain",
      scopeKey: `domain:${hostname}`,
      platform,
    };
  }

  // Default: domain-level claim
  return {
    scope: "domain",
    scopeKey: `domain:${hostname}`,
    platform,
  };
}

function resolveProofMethod(platform: SourcePlatform): "well_known_json" | "github_repo_file" | "manual_review" {
  if (platform === "github") return "github_repo_file";
  return "well_known_json";
}

// ─── GET ──────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({
      walletAddress: null,
      claims: [],
      authenticated: false,
    });
  }

  const { data, error } = await supabaseAdmin()
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .order("updated_at", { ascending: false });

  if (error) return creatorProfileDbError("get_claims", error);
  if (sid) await refreshSession(sid);

  return NextResponse.json({ walletAddress, claims: (data ?? []) as CreatorClaim[] });
}

// ─── POST ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { sid, walletAddress } = await getWalletSession(req);
  if (!walletAddress) {
    return NextResponse.json({ error: "Connected Creator Wallet required" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { creator_name?: unknown; source_url?: unknown };
  const creatorName = typeof body.creator_name === "string" ? body.creator_name.trim() : "";
  if (creatorName.length < 2 || creatorName.length > 80) {
    return NextResponse.json({ error: "creator_name must be 2-80 characters" }, { status: 400 });
  }

  const parsed = parseHttpsUrl(body.source_url);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const hostname = parsed.domain!;
  const { scope, scopeKey, platform } = detectClaimScope(parsed.url!, hostname);
  const proofMethod = resolveProofMethod(platform);
  const proofNonce = generateNonce();

  const supabase = supabaseAdmin();

  // Check for existing claim on same scope_key + wallet
  const { data: existing, error: selectError } = await supabase
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .eq("claim_scope_key", scopeKey)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (selectError) return creatorProfileDbError("select_claim", selectError);

  const existingClaim = (existing?.[0] ?? null) as CreatorClaim | null;
  if (existingClaim && LOCKED_STATUSES.has(existingClaim.claim_status)) {
    return NextResponse.json(
      { error: `Existing ${existingClaim.claim_status} claim cannot be overwritten silently`, claim: existingClaim, walletAddress },
      { status: 409 },
    );
  }

  // Check if another wallet already verified this scope
  const { data: scopeConflict } = await supabase
    .from("paylabs_creator_claims")
    .select("id, creator_wallet, claim_status")
    .eq("claim_scope_key", scopeKey)
    .eq("claim_status", "verified")
    .neq("creator_wallet", walletAddress)
    .limit(1);

  if (scopeConflict && scopeConflict.length > 0) {
    return NextResponse.json(
      { error: "This source scope is already verified by another creator. Only one wallet can own a given source." },
      { status: 409 },
    );
  }

  const claimRow = {
    creator_wallet: walletAddress,
    creator_name: creatorName,
    source_url: parsed.url,
    source_domain: hostname,
    canonical_url: parsed.url,
    claim_scope: scope,
    claim_scope_key: scopeKey,
    source_platform: platform,
    claim_status: "unclaimed" as const,
    verification_method: proofMethod === "manual_review" ? "manual_review" : "auto_verify",
    proof_method: proofMethod,
    proof_status: "pending" as const,
    proof_nonce: proofNonce,
    proof_checked_at: null,
    proof_error: null,
    verified_at: null,
  };

  if (existingClaim) {
    const { data, error } = await supabase
      .from("paylabs_creator_claims")
      .update({
        ...claimRow,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingClaim.id)
      .select(SAFE_CLAIM_COLUMNS)
      .single();

    if (error) return creatorProfileDbError("update_claim", error);
    if (sid) await refreshSession(sid);
    return NextResponse.json({ walletAddress, claim: data as CreatorClaim });
  }

  const { data, error } = await supabase
    .from("paylabs_creator_claims")
    .insert(claimRow)
    .select(SAFE_CLAIM_COLUMNS)
    .single();

  if (error) return creatorProfileDbError("insert_claim", error);
  if (sid) await refreshSession(sid);

  return NextResponse.json({ walletAddress, claim: data as CreatorClaim });
}
