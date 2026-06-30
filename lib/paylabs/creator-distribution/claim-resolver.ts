/**
 * Creator Claim Resolver
 *
 * Maps a discovered source URL to a verified creator claim.
 * Used by RSSHub sync and runtime live source enrichment.
 *
 * Resolution priority (first match wins):
 * 1. github_repo:<owner>/<repo>  — exact GitHub repo match
 * 2. host:<exact-host>           — tenant hosts (*.vercel.app, *.netlify.app, *.github.io)
 * 3. domain:<hostname>           — domain-level claim (fallback)
 * 4. Exact canonical_url match   — last resort
 *
 * Also supports legacy domain:<host> keys for tenant hosts during transition.
 *
 * No LLM. No network. Pure DB query.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Types ─────────────────────────────────────────────────────

export interface ResolvedClaim {
  claim_id: string;
  creator_wallet: string;
  creator_name: string | null;
  claim_scope_key: string;
  match_type: "github_repo" | "host" | "domain" | "canonical_url";
}

// ─── URL Parsing ───────────────────────────────────────────────

function parseSourceUrl(url: string): {
  hostname: string;
  pathname: string;
  owner: string | null;
  repo: string | null;
} | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    // GitHub repo detection
    if (hostname === "github.com" || hostname === "www.github.com") {
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/, "");
        if (/^[A-Za-z0-9_.-]{1,100}$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
          return { hostname, pathname, owner, repo };
        }
      }
    }

    return { hostname, pathname, owner: null, repo: null };
  } catch {
    return null;
  }
}

/** Detect if hostname is a tenant host (shared platform subdomain). */
function isTenantHost(hostname: string): boolean {
  return (
    hostname.endsWith(".github.io") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".netlify.app")
  );
}

// ─── Resolver ──────────────────────────────────────────────────

/**
 * Resolve a source URL to a verified creator claim.
 * Returns null if no verified claim matches.
 */
export async function resolveCreatorClaim(
  sourceUrl: string
): Promise<ResolvedClaim | null> {
  const parsed = parseSourceUrl(sourceUrl);
  if (!parsed) return null;

  const { hostname, owner, repo } = parsed;
  const db = supabaseAdmin();

  // Priority 1: GitHub repo match
  if (owner && repo) {
    const scopeKey = `github_repo:${owner}/${repo}`;
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key")
      .eq("claim_scope_key", scopeKey)
      .eq("claim_status", "verified")
      .limit(1)
      .single();

    if (data) {
      return {
        claim_id: data.id,
        creator_wallet: data.creator_wallet.toLowerCase(),
        creator_name: data.creator_name,
        claim_scope_key: data.claim_scope_key,
        match_type: "github_repo",
      };
    }
  }

  // Priority 2: Tenant host match (host:<exact-host>)
  // Supports both new host:<host> and legacy domain:<host> keys during transition
  if (isTenantHost(hostname)) {
    const hostKey = `host:${hostname}`;
    const domainKey = `domain:${hostname}`;

    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key")
      .in("claim_scope_key", [hostKey, domainKey])
      .eq("claim_status", "verified")
      .limit(1)
      .single();

    if (data) {
      return {
        claim_id: data.id,
        creator_wallet: data.creator_wallet.toLowerCase(),
        creator_name: data.creator_name,
        claim_scope_key: data.claim_scope_key,
        match_type: "host",
      };
    }
  }

  // Priority 3: Domain-level match (domain:<hostname>)
  {
    const scopeKey = `domain:${hostname}`;
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key")
      .eq("claim_scope_key", scopeKey)
      .eq("claim_status", "verified")
      .limit(1)
      .single();

    if (data) {
      return {
        claim_id: data.id,
        creator_wallet: data.creator_wallet.toLowerCase(),
        creator_name: data.creator_name,
        claim_scope_key: data.claim_scope_key,
        match_type: "domain",
      };
    }
  }

  // Priority 4: Exact canonical_url match
  {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key, canonical_url")
      .eq("canonical_url", sourceUrl)
      .eq("claim_status", "verified")
      .limit(1)
      .single();

    if (data) {
      return {
        claim_id: data.id,
        creator_wallet: data.creator_wallet.toLowerCase(),
        creator_name: data.creator_name,
        claim_scope_key: data.claim_scope_key,
        match_type: "canonical_url",
      };
    }
  }

  return null;
}

/**
 * Batch resolve multiple source URLs.
 * Returns a Map of sourceUrl → ResolvedClaim (null if no match).
 * Uses a single DB query per priority level for efficiency.
 */
export async function resolveCreatorClaimsBatch(
  sourceUrls: string[]
): Promise<Map<string, ResolvedClaim | null>> {
  const result = new Map<string, ResolvedClaim | null>();

  if (sourceUrls.length === 0) return result;

  // Parse all URLs and build lookup structures
  const parsed = sourceUrls.map((url) => ({ url, parsed: parseSourceUrl(url) }));

  // Collect all scope keys to query
  const githubKeys: string[] = [];
  const hostKeys: string[] = [];
  const domainKeys: string[] = [];
  const canonicalUrls: string[] = [];

  for (const { url, parsed: p } of parsed) {
    if (!p) {
      result.set(url, null);
      continue;
    }

    if (p.owner && p.repo) {
      githubKeys.push(`github_repo:${p.owner}/${p.repo}`);
    }

    if (isTenantHost(p.hostname)) {
      hostKeys.push(`host:${p.hostname}`);
      // Also add legacy domain:<host> for transition
      domainKeys.push(`domain:${p.hostname}`);
    }

    domainKeys.push(`domain:${p.hostname}`);
    canonicalUrls.push(url);
  }

  // Deduplicate
  const uniqueGithubKeys = [...new Set(githubKeys)];
  const uniqueHostKeys = [...new Set(hostKeys)];
  const uniqueDomainKeys = [...new Set(domainKeys)];
  const uniqueCanonicalUrls = [...new Set(canonicalUrls)];

  const db = supabaseAdmin();

  // Batch query all verified claims with matching scope keys
  const allScopeKeys = [...new Set([...uniqueGithubKeys, ...uniqueHostKeys, ...uniqueDomainKeys])];

  let claimsByScopeKey = new Map<string, { id: string; creator_wallet: string; creator_name: string | null; claim_scope_key: string }>();
  let claimsByCanonicalUrl = new Map<string, { id: string; creator_wallet: string; creator_name: string | null; claim_scope_key: string }>();

  if (allScopeKeys.length > 0) {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key, canonical_url")
      .in("claim_scope_key", allScopeKeys)
      .eq("claim_status", "verified");

    if (data) {
      for (const claim of data) {
        claimsByScopeKey.set(claim.claim_scope_key, claim);
        if (claim.canonical_url) {
          claimsByCanonicalUrl.set(claim.canonical_url, claim);
        }
      }
    }
  }

  // Resolve each URL by priority
  for (const { url, parsed: p } of parsed) {
    if (!p || result.has(url)) continue;

    // Priority 1: GitHub repo
    if (p.owner && p.repo) {
      const key = `github_repo:${p.owner}/${p.repo}`;
      const claim = claimsByScopeKey.get(key);
      if (claim) {
        result.set(url, {
          claim_id: claim.id,
          creator_wallet: claim.creator_wallet.toLowerCase(),
          creator_name: claim.creator_name,
          claim_scope_key: claim.claim_scope_key,
          match_type: "github_repo",
        });
        continue;
      }
    }

    // Priority 2: Tenant host (host:<host> or legacy domain:<host>)
    if (isTenantHost(p.hostname)) {
      const hostClaim = claimsByScopeKey.get(`host:${p.hostname}`);
      const legacyClaim = claimsByScopeKey.get(`domain:${p.hostname}`);
      const claim = hostClaim || legacyClaim;
      if (claim) {
        result.set(url, {
          claim_id: claim.id,
          creator_wallet: claim.creator_wallet.toLowerCase(),
          creator_name: claim.creator_name,
          claim_scope_key: claim.claim_scope_key,
          match_type: "host",
        });
        continue;
      }
    }

    // Priority 3: Domain
    {
      const key = `domain:${p.hostname}`;
      const claim = claimsByScopeKey.get(key);
      if (claim) {
        result.set(url, {
          claim_id: claim.id,
          creator_wallet: claim.creator_wallet.toLowerCase(),
          creator_name: claim.creator_name,
          claim_scope_key: claim.claim_scope_key,
          match_type: "domain",
        });
        continue;
      }
    }

    // Priority 4: Exact canonical_url
    {
      const claim = claimsByCanonicalUrl.get(url);
      if (claim) {
        result.set(url, {
          claim_id: claim.id,
          creator_wallet: claim.creator_wallet.toLowerCase(),
          creator_name: claim.creator_name,
          claim_scope_key: claim.claim_scope_key,
          match_type: "canonical_url",
        });
        continue;
      }
    }

    result.set(url, null);
  }

  return result;
}
