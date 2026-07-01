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
        const owner = parts[0].toLowerCase();
        const repo = parts[1].replace(/\.git$/, "").toLowerCase();
        if (/^[A-Za-z0-9_.-]{1,100}$/.test(owner) && /^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
          return { hostname, pathname, owner, repo, platformProfileKey: null };
        }
      }
    }

    // Twitter/X profile
    if (hostname === "twitter.com" || hostname === "x.com") {
      const RESERVED_X = new Set([
        "home", "search", "i", "settings", "notifications", "messages",
        "explore", "compose", "login", "signup", "download", "tos",
        "privacy", "about", "jobs", "intent", "share", "hashtag",
      ]);
      if (parts.length >= 1 && parts[0] && !RESERVED_X.has(parts[0].toLowerCase()) && !parts[0].startsWith("-")) {
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
    const { data, error: scopeKeyError } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key, canonical_url")
      .in("claim_scope_key", allScopeKeys)
      .eq("claim_status", "verified");

    if (scopeKeyError) {
      throw new Error(`claim-resolver: scope_key query failed: ${scopeKeyError.message}`);
    }

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
    const { data, error: canonicalUrlError } = await db
      .from("paylabs_creator_claims")
      .select("id, creator_wallet, creator_name, claim_scope_key, canonical_url")
      .in("canonical_url", unmatchedCanonicalUrls)
      .eq("claim_status", "verified");

    if (canonicalUrlError) {
      throw new Error(`claim-resolver: canonical_url query failed: ${canonicalUrlError.message}`);
    }

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

// ─── Exact URL Matching Helper ─────────────────────────────────

/** Minimal claim shape needed for canonicalUrl matching. */
export interface ClaimMatchInput {
  claim_scope: string | null;
  claim_scope_key: string | null;
  source_url: string | null;
  source_domain: string | null;
  canonical_url: string | null;
}

/**
 * Determine whether a feed item's canonical_url belongs to a given claim,
 * based on claim scope. Pure function — no DB, no network.
 *
 * Returns false for invalid/unparseable URLs.
 */
export function canonicalUrlMatchesClaim(canonicalUrl: string, claim: ClaimMatchInput): boolean {
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  const scope = claim.claim_scope;

  if (scope === "exact_url") {
    return canonicalUrl === claim.canonical_url || canonicalUrl === claim.source_url;
  }

  if (scope === "github_repo") {
    const scopeKey = claim.claim_scope_key;
    if (!scopeKey) return false;
    const repoPath = scopeKey.replace("github_repo:", "").toLowerCase();
    const [owner, repo] = repoPath.split("/");
    if (!owner || !repo) return false;
    if (hostname !== "github.com" && hostname !== "www.github.com") return false;
    if (parts.length < 2) return false;
    const urlOwner = parts[0].toLowerCase();
    const urlRepo = parts[1].replace(/\.git$/, "").toLowerCase();
    return urlOwner === owner && urlRepo === repo;
  }

  if (scope === "platform_profile") {
    const scopeKey = claim.claim_scope_key;
    if (!scopeKey) return false;
    const keyParts = scopeKey.split(":");
    if (keyParts.length < 3) return false;
    const platform = keyParts[1];
    const handle = keyParts.slice(2).join(":").toLowerCase();

    if (platform === "x" || platform === "twitter") {
      if (hostname !== "x.com" && hostname !== "twitter.com") return false;
      if (parts.length < 1 || !parts[0]) return false;
      const RESERVED_X = new Set([
        "home", "search", "i", "settings", "notifications", "messages",
        "explore", "compose", "login", "signup", "download", "tos",
        "privacy", "about", "jobs", "intent", "share", "hashtag",
      ]);
      const urlHandle = parts[0].toLowerCase();
      if (RESERVED_X.has(urlHandle) || urlHandle.startsWith("-")) return false;
      return urlHandle === handle;
    }

    if (platform === "youtube") {
      if (hostname !== "youtube.com" && hostname !== "www.youtube.com") return false;
      if (parts.length < 1 || !parts[0]) return false;
      // /@handle
      if (parts[0].startsWith("@")) {
        return parts[0].slice(1).toLowerCase() === handle;
      }
      // /channel/<id>
      if (parts[0] === "channel" && parts.length >= 2) {
        return parts[1] === handle;
      }
      return false;
    }

    if (platform === "medium") {
      if (hostname !== "medium.com") return false;
      if (parts.length < 1 || !parts[0]) return false;
      if (!parts[0].startsWith("@")) return false;
      return parts[0].slice(1).toLowerCase() === handle;
    }

    return false;
  }

  // Domain scope intentionally covers subdomains (e.g. blog.example.com matches example.com).
  // Host scope is exact hostname only — use host for single-property claims.
  if (scope === "domain") {
    if (!claim.source_domain) return false;
    const domain = claim.source_domain.toLowerCase();
    return hostname === domain || hostname.endsWith("." + domain);
  }

  if (scope === "host") {
    if (!claim.source_domain) return false;
    return hostname === claim.source_domain.toLowerCase();
  }

  return false;
}

// ─── Post-Verification Feed Item Sync ──────────────────────────

export interface SyncFeedItemsResult {
  matched: number;
  priceDerived: number;
  updated: number;
}

const SYNC_PAGE_SIZE = 1000;

/**
 * Fetch all active feed items in paginated batches (Supabase default limit = 1000).
 * Returns only the selected columns for each row.
 */
async function fetchAllActiveFeedItems(
  db: ReturnType<typeof supabaseAdmin>,
  selectCols: string,
): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from("paylabs_feed_items")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select(selectCols as any)
      .eq("is_active", true)
      .range(offset, offset + SYNC_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`fetchAllActiveFeedItems: query failed at offset ${offset}: ${error.message}`);
    }
    // Supabase generic select returns untyped data — cast safely
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) break;
    allRows.push(...rows);
    if (rows.length < SYNC_PAGE_SIZE) break;
    offset += SYNC_PAGE_SIZE;
  }
  return allRows;
}

/**
 * After a claim is verified, update existing matching feed items
 * to set creator_wallet and claim_status.
 *
 * Only marks is_monetized=true when price_per_citation_usdc > 0.
 * Derives default prices from the linked rsshub route when available.
 * Never overwrites non-zero prices.
 * Respects resolver priority — skips rows owned by a higher-priority verified claim.
 */
export async function syncVerifiedCreatorClaimToFeedItems(
  claim: { id: string; creator_wallet: string; claim_status: string; claim_scope: string | null; claim_scope_key: string | null; source_url: string | null; source_domain: string | null; canonical_url: string | null },
): Promise<SyncFeedItemsResult> {
  if (claim.claim_status !== "verified") {
    return { matched: 0, priceDerived: 0, updated: 0 };
  }

  const db = supabaseAdmin();
  const wallet = claim.creator_wallet.toLowerCase();
  const idPrefix = claim.id.slice(0, 8);

  // Fetch all active feed items with pricing + route columns (paginated)
  const allActive = await fetchAllActiveFeedItems(
    db,
    "canonical_url, creator_wallet, claim_status, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, rsshub_route_id",
  );

  if (allActive.length === 0) {
    return { matched: 0, priceDerived: 0, updated: 0 };
  }

  // Filter using canonicalUrlMatchesClaim (exact scope matching, no LIKE)
  const matchedRows: Record<string, unknown>[] = [];
  for (const row of allActive) {
    if (row.canonical_url && canonicalUrlMatchesClaim(row.canonical_url as string, claim)) {
      matchedRows.push(row);
    }
  }

  if (matchedRows.length === 0) {
    return { matched: 0, priceDerived: 0, updated: 0 };
  }

  // Collect matched URLs for priority check
  const matchedUrls = matchedRows.map((r) => r.canonical_url as string);

  // Priority check: resolve each URL to see if a higher-priority claim owns it
  const resolvedMap = await resolveCreatorClaimsBatch(matchedUrls);

  // Collect rsshub_route_ids that need default prices
  const routeIdsNeedingDefaults = new Set<string>();
  for (const row of matchedRows) {
    const hasPrice = ((row.price_per_citation_usdc as number | null) ?? 0) > 0;
    const routeId = row.rsshub_route_id as string | null;
    if (!hasPrice && routeId) {
      routeIdsNeedingDefaults.add(routeId);
    }
  }

  // Load route defaults in batch
  const routeDefaults = new Map<string, { citation: number; unlock: number }>();
  if (routeIdsNeedingDefaults.size > 0) {
    const { data: routes, error: routeError } = await db
      .from("paylabs_rsshub_routes")
      .select("id, default_price_per_citation_usdc, default_price_per_unlock_usdc")
      .in("id", [...routeIdsNeedingDefaults]);

    if (routeError) {
      console.error("[syncVerifiedClaim] failed to load route defaults", { code: routeError.code ?? null });
      // Non-fatal: continue without route defaults
    } else if (routes) {
      for (const r of routes) {
        const citation = (r.default_price_per_citation_usdc as number | null) ?? 0;
        const unlock = (r.default_price_per_unlock_usdc as number | null) ?? 0;
        if (citation > 0) {
          routeDefaults.set(r.id, { citation, unlock });
        }
      }
    }
  }

  // Build update list: apply priority + price derivation logic
  let priceDerived = 0;
  const toUpdate: { url: string; updateFields: Record<string, unknown> }[] = [];

  for (const row of matchedRows) {
    const url = row.canonical_url as string;

    // Priority check: skip if resolver returns a different wallet
    const resolved = resolvedMap.get(url);
    if (resolved && resolved.creator_wallet.toLowerCase() !== wallet) {
      continue;
    }

    const updateFields: Record<string, unknown> = {
      creator_wallet: wallet,
      claim_status: "claimed",
    };

    const currentCitationPrice = (row.price_per_citation_usdc as number | null) ?? 0;
    const currentUnlockPrice = (row.price_per_unlock_usdc as number | null) ?? 0;
    const routeId = row.rsshub_route_id as string | null;

    if (currentCitationPrice > 0) {
      // Already has positive price — safe to monetize, don't touch prices
      updateFields.is_monetized = true;
    } else if (routeId && routeDefaults.has(routeId)) {
      // Derive price from route defaults
      const defaults = routeDefaults.get(routeId)!;
      updateFields.price_per_citation_usdc = defaults.citation;
      if (currentUnlockPrice <= 0 && defaults.unlock > 0) {
        updateFields.price_per_unlock_usdc = defaults.unlock;
      }
      updateFields.is_monetized = true;
      priceDerived++;
    } else {
      // No price and no route default — claim the row but don't monetize
      updateFields.is_monetized = false;
    }

    toUpdate.push({ url, updateFields });
  }

  if (toUpdate.length === 0) {
    return { matched: matchedRows.length, priceDerived: 0, updated: 0 };
  }

  // Update in batch (grouped by identical update fields for efficiency)
  // Since most rows share the same update shape, batch by URL list
  const monetizedUrls = toUpdate.filter((u) => u.updateFields.is_monetized === true).map((u) => u.url);
  const claimedOnlyUrls = toUpdate.filter((u) => u.updateFields.is_monetized === false).map((u) => u.url);

  let updatedCount = 0;

  // Update monetized rows (has price)
  if (monetizedUrls.length > 0) {
    // Build the common update payload for monetized rows
    // Price derivation may differ per row, so update individually for rows needing price
    const needsPriceUpdate = toUpdate.filter(
      (u) => u.updateFields.is_monetized === true && "price_per_citation_usdc" in u.updateFields,
    );
    const noPriceUpdate = toUpdate.filter(
      (u) => u.updateFields.is_monetized === true && !("price_per_citation_usdc" in u.updateFields),
    );

    // Rows that already had positive price — simple update
    if (noPriceUpdate.length > 0) {
      const { data: rows, error: err } = await db
        .from("paylabs_feed_items")
        .update({ creator_wallet: wallet, is_monetized: true, claim_status: "claimed" })
        .in("canonical_url", noPriceUpdate.map((u) => u.url))
        .eq("is_active", true)
        .select("canonical_url");

      if (err) {
        throw new Error(`syncVerifiedCreatorClaimToFeedItems: update (monetized) failed for claim ${idPrefix}: ${err.message}`);
      }
      updatedCount += rows?.length ?? 0;
    }

    // Rows needing price derivation — update one by one (different prices per route)
    for (const item of needsPriceUpdate) {
      const { data: rows, error: err } = await db
        .from("paylabs_feed_items")
        .update(item.updateFields)
        .eq("canonical_url", item.url)
        .eq("is_active", true)
        .select("canonical_url");

      if (err) {
        throw new Error(`syncVerifiedCreatorClaimToFeedItems: update (price-derived) failed for claim ${idPrefix}: ${err.message}`);
      }
      updatedCount += rows?.length ?? 0;
    }
  }

  // Rows claimed but not monetized (no price, no route default)
  if (claimedOnlyUrls.length > 0) {
    const { data: rows, error: err } = await db
      .from("paylabs_feed_items")
      .update({ creator_wallet: wallet, is_monetized: false, claim_status: "claimed" })
      .in("canonical_url", claimedOnlyUrls)
      .eq("is_active", true)
      .select("canonical_url");

    if (err) {
      throw new Error(`syncVerifiedCreatorClaimToFeedItems: update (claimed-only) failed for claim ${idPrefix}: ${err.message}`);
    }
    updatedCount += rows?.length ?? 0;
  }

  return { matched: matchedRows.length, priceDerived, updated: updatedCount };
}
