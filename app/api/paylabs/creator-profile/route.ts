import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
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

type ClaimScope = "exact_url" | "domain" | "host" | "github_repo" | "platform_profile" | "manual";
type SourcePlatform = "domain" | "github" | "vercel" | "netlify" | "github_pages" | "rss_publisher" | "twitter" | "youtube" | "medium" | "substack" | "unsupported";

const SOCIAL_HOSTS: Record<string, SourcePlatform> = {
  "twitter.com": "twitter",
  "x.com": "twitter",
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "youtu.be": "youtube",
  "medium.com": "medium",
};

function detectSourcePlatform(hostname: string): SourcePlatform {
  if (hostname === "github.com" || hostname === "www.github.com") return "github";
  if (hostname.endsWith(".github.io")) return "github_pages";
  if (hostname.endsWith(".vercel.app")) return "vercel";
  if (hostname.endsWith(".netlify.app")) return "netlify";
  if (hostname.endsWith(".substack.com")) return "substack";
  return SOCIAL_HOSTS[hostname] || "domain";
}

/**
 * Extract social handle from URL path.
 * Returns null if not a recognizable social profile URL.
 */
function extractSocialHandle(url: string, hostname: string, platform: SourcePlatform): string | null {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);

    if (platform === "twitter") {
      // twitter.com/<handle> or x.com/<handle>
      // Reject reserved paths that are not profile handles
      const RESERVED_X = new Set([
        "home", "search", "i", "settings", "notifications", "messages",
        "explore", "compose", "login", "signup", "download", "tos",
        "privacy", "about", "jobs", "intent", "share", "hashtag",
      ]);
      if (parts.length >= 1 && parts[0] && !RESERVED_X.has(parts[0].toLowerCase()) && !parts[0].startsWith("-")) {
        return parts[0].toLowerCase();
      }
    }

    if (platform === "youtube") {
      // youtube.com/@handle
      if (parts.length >= 1 && parts[0]?.startsWith("@")) {
        return parts[0].slice(1).toLowerCase();
      }
      // youtube.com/channel/<id>
      if (parts.length >= 2 && parts[0] === "channel") {
        return parts[1];
      }
    }

    if (platform === "medium") {
      // medium.com/@handle
      if (parts.length >= 1 && parts[0]?.startsWith("@")) {
        return parts[0].slice(1).toLowerCase();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function detectClaimScope(url: string, hostname: string): { scope: ClaimScope; scopeKey: string; platform: SourcePlatform } {
  const platform = detectSourcePlatform(hostname);

  // GitHub repo: https://github.com/owner/repo or deeper
  if (hostname === "github.com" || hostname === "www.github.com") {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0].toLowerCase();
      const repo = parts[1].replace(/\.git$/, "").toLowerCase();
      return {
        scope: "github_repo",
        scopeKey: `github_repo:${owner}/${repo}`,
        platform: "github",
      };
    }
  }

  // Tenant hosts (shared platform subdomains): host-level claim
  // *.github.io, *.vercel.app, *.netlify.app, *.substack.com
  if (
    hostname.endsWith(".github.io") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".netlify.app") ||
    hostname.endsWith(".substack.com")
  ) {
    return {
      scope: "host",
      scopeKey: `host:${hostname}`,
      platform,
    };
  }

  // Social platforms: platform_profile scope with extracted handle
  if (platform !== "domain") {
    const handle = extractSocialHandle(url, hostname, platform);
    if (handle) {
      // Normalize twitter/x to "x" for scope key
      const platformKey = platform === "twitter" ? "x" : platform;
      return {
        scope: "platform_profile",
        scopeKey: `platform_profile:${platformKey}:${handle}`,
        platform,
      };
    }
    // No handle extracted — reject. Do NOT fall back to host:x.com etc.
    return {
      scope: null as unknown as ClaimScope,
      scopeKey: "",
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

function resolveProofMethod(platform: SourcePlatform): "well_known_json" | "github_repo_file" | "hosted_link_backlink" | "manual_review" {
  if (platform === "github") return "github_repo_file";
  if (["twitter", "youtube", "medium", "substack"].includes(platform)) return "hosted_link_backlink";
  if (["github_pages", "vercel", "netlify"].includes(platform)) return "well_known_json";
  return "hosted_link_backlink"; // default for "domain" and anything unrecognized
}

/**
 * Get equivalent scope keys for a claim scope.
 * Tenant hosts have two possible keys: host:<host> and legacy domain:<host>.
 * This ensures conflict checks catch both old and new claims.
 */
function getEquivalentScopeKeys(scope: ClaimScope, scopeKey: string, hostname: string): string[] {
  if (scope === "host" || (scope === "domain" && isTenantHost(hostname))) {
    // Tenant host: check both host:<host> and domain:<host>
    return [`host:${hostname}`, `domain:${hostname}`];
  }
  return [scopeKey];
}

function isTenantHost(hostname: string): boolean {
  return (
    hostname.endsWith(".github.io") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".netlify.app") ||
    hostname.endsWith(".substack.com")
  );
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

  // Reject social platform URLs where handle extraction failed
  if (!scope || !scopeKey) {
    return NextResponse.json(
      { error: "Unsupported profile URL. Use a direct creator profile URL (e.g. x.com/username, youtube.com/@handle, medium.com/@handle)." },
      { status: 400 },
    );
  }

  const proofMethod = resolveProofMethod(platform);
  const proofNonce = generateNonce();

  const supabase = supabaseAdmin();

  // Get all equivalent scope keys for conflict checking
  // Tenant hosts have both host:<host> and legacy domain:<host>
  const equivalentKeys = getEquivalentScopeKeys(scope, scopeKey, hostname);

  // Check for existing claim on same scope_key + wallet (check all equivalent keys)
  const { data: existing, error: selectError } = await supabase
    .from("paylabs_creator_claims")
    .select(SAFE_CLAIM_COLUMNS)
    .eq("creator_wallet", walletAddress)
    .in("claim_scope_key", equivalentKeys)
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

  // Check if another wallet already verified this scope (check all equivalent keys)
  const { data: scopeConflict } = await supabase
    .from("paylabs_creator_claims")
    .select("id, creator_wallet, claim_status")
    .in("claim_scope_key", equivalentKeys)
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
