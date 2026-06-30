/**
 * Creator Claim Resolver
 *
 * Maps a discovered source URL to a verified creator claim.
 * Used by RSSHub sync and runtime live source enrichment.
 *
 * Resolution priority (first match wins):
 * 1. github_repo:<owner>/<repo>        — exact GitHub repo match
 * 2. platform_profile:<platform>:<handle> — social profile match
 * 3. host:<exact-host>                 — tenant hosts (*.vercel.app, *.netlify.app, *.github.io, *.substack.com)
 * 4. domain:<hostname>                 — domain-level claim (fallback)
 * 5. Exact canonical_url match         — last resort
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
  match_type: "github_repo" | "platform_profile" | "host" | "domain" | "canonical_url";
}

// ─── URL Parsing ───────────────────────────────────────────────

interface ParsedSource {
  hostname: string;
  pathname: string;
  owner: string | null;
  repo: string | null;
  platformProfileKey: string | null;
}

function parseSourceUrl(url: string): ParsedSource | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    const parts = pathname.split("/").filter(Boolean);

    // GitHub repo detection
    if (hostname === "github.com" || hostname === "www.github.com") {
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/, "");
        if (/^[A-Za-z0-9_.-]{1,100}$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
          return { hostname, pathname, owner, repo, platformProfileKey: null };
        }
      }
    }

    // Twitter/X profile
    if (hostname === "twitter.com" || hostname === "x.com") {
      if (parts.length >= 1 && parts[0] && !["search", "settings", "notifications", "messages", "explore", "i"].includes(parts[0])) {
        return { hostname, pathname, owner: null, repo: null, platformProfileKey: `platform_profile:x:${parts[0].toLowerCase()}` };
      }
    }

    // YouTube profile
    if (hostname === "youtube.com" || hostname === "www.youtube.com") {
      if (parts.length >= 1 && parts[0]?.startsWith("@")) {
        return { hostname, pathname, owner: null, repo: null, platformProfileKey: `platform_profile:youtube:${parts[0].slice(1).toLowerCase()}` };
      }
      if (parts.length >= 2 && parts[0] === "channel") {
        return { hostname, pathname, owner: null, repo: null, platformProfileKey: `platform_profile:youtube:${parts[1]}` };
      }
    }

    // Medium profile
    if (hostname === "medium.com") {
      if (parts.length >= 1 && parts[0]?.startsWith("@")) {
        return { hostname, pathname, owner: null, repo: null, platformProfileKey: `platform_profile:medium:${parts[0].slice(1).toLowerCase()}` };
      }
    }

    return { hostname, pathname, owner: null, repo: null, platformProfileKey: null };
  } catch {
    return null;
  }
}

/** Detect if hostname is a tenant host (shared platform subdomain). */
function isTenantHost(hostname: string): boolean {
  return (
    hostname.endsWith(".github.io") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".netlify.app") ||
    hostname.endsWith(".substack.com")
  );
}

// ─── Resolver (single URL) ────────────────────────────────────

/**
 * Resolve a source URL to a verified creator claim.
 * Returns null if no verified claim matches.
 */
export async function resolveCreatorClaim(
  sourceUrl: string
): Promise<ResolvedClaim | null> {
  const parsed = parseSourceUrl(sourceUrl);
  if (!parsed) return null;

  const { hostname, owner, repo, platformProfileKey } = parsed;
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

  // Priority 2: Platform profile match
  if (platformProfileKey) {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key")
      .eq("claim_scope_key", platformProfileKey)
      .eq("claim_status", "verified")
      .limit(1)
      .single();

    if (data) {
      return {
        claim_id: data.id,
        creator_wallet: data.creator_wallet.toLowerCase(),
        creator_name: data.creator_name,
        claim_scope_key: data.claim_scope_key,
        match_type: "platform_profile",
      };
    }
  }

  // Priority 3: Tenant host match (host:<exact-host>)
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

  // Priority 4: Domain-level match (domain:<hostname>)
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

  // Priority 5: Exact canonical_url match
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

// ─── Batch Resolver ────────────────────────────────────────────

type ClaimRow = { id: string; creator_wallet: string; creator_name: string | null; claim_scope_key: string; canonical_url: string | null };

function toResolved(row: ClaimRow, matchType: ResolvedClaim["match_type"]): ResolvedClaim {
  return {
    claim_id: row.id,
    creator_wallet: row.creator_wallet.toLowerCase(),
    creator_name: row.creator_name,
    claim_scope_key: row.claim_scope_key,
    match_type: matchType,
  };
}

/**
 * Batch resolve multiple source URLs.
 * Returns a Map of sourceUrl → ResolvedClaim (null if no match).
 * Uses batched DB queries per priority level for efficiency.
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
  const platformProfileKeys: string[] = [];
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

    if (p.platformProfileKey) {
      platformProfileKeys.push(p.platformProfileKey);
    }

    if (isTenantHost(p.hostname)) {
      hostKeys.push(`host:${p.hostname}`);
      // Legacy domain:<host> for transition
      domainKeys.push(`domain:${p.hostname}`);
    }

    domainKeys.push(`domain:${p.hostname}`);
    canonicalUrls.push(url);
  }

  // Deduplicate
  const uniqueGithubKeys = [...new Set(githubKeys)];
  const uniquePlatformProfileKeys = [...new Set(platformProfileKeys)];
  const uniqueHostKeys = [...new Set(hostKeys)];
  const uniqueDomainKeys = [...new Set(domainKeys)];
  const uniqueCanonicalUrls = [...new Set(canonicalUrls)];

  const db = supabaseAdmin();

  // Build maps from batch queries
  const claimsByScopeKey = new Map<string, ClaimRow>();
  const claimsByCanonicalUrl = new Map<string, ClaimRow>();

  // Query 1: scope_key IN (all scope keys)
  const allScopeKeys = [...new Set([...uniqueGithubKeys, ...uniquePlatformProfileKeys, ...uniqueHostKeys, ...uniqueDomainKeys])];

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

  // Query 2: canonical_url IN (only URLs not already found via scope_key)
  const unmatchedCanonicalUrls = uniqueCanonicalUrls.filter((url) => !claimsByCanonicalUrl.has(url));

  if (unmatchedCanonicalUrls.length > 0) {
    const { data } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key, canonical_url")
      .in("canonical_url", unmatchedCanonicalUrls)
      .eq("claim_status", "verified");

    if (data) {
      for (const claim of data) {
        if (claim.canonical_url && !claimsByCanonicalUrl.has(claim.canonical_url)) {
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
        result.set(url, toResolved(claim, "github_repo"));
        continue;
      }
    }

    // Priority 2: Platform profile
    if (p.platformProfileKey) {
      const claim = claimsByScopeKey.get(p.platformProfileKey);
      if (claim) {
        result.set(url, toResolved(claim, "platform_profile"));
        continue;
      }
    }

    // Priority 3: Tenant host (host:<host> or legacy domain:<host>)
    if (isTenantHost(p.hostname)) {
      const hostClaim = claimsByScopeKey.get(`host:${p.hostname}`);
      const legacyClaim = claimsByScopeKey.get(`domain:${p.hostname}`);
      const claim = hostClaim || legacyClaim;
      if (claim) {
        result.set(url, toResolved(claim, "host"));
        continue;
      }
    }

    // Priority 4: Domain
    {
      const key = `domain:${p.hostname}`;
      const claim = claimsByScopeKey.get(key);
      if (claim) {
        result.set(url, toResolved(claim, "domain"));
        continue;
      }
    }

    // Priority 5: Exact canonical_url
    {
      const claim = claimsByCanonicalUrl.get(url);
      if (claim) {
        result.set(url, toResolved(claim, "canonical_url"));
        continue;
      }
    }

    result.set(url, null);
  }

  return result;
}
