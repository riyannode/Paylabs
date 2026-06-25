/**
 * RSSHub Live Search
 *
 * Full pipeline: catalog → route search → route resolver → bounded fetch → rank items.
 * Top-level entry point for live RSSHub source discovery.
 *
 * No LLM. No secrets. No raw payload exposure.
 */

import { createHash } from "node:crypto";
import { getRsshubCatalog } from "./rsshub-catalog";
import { searchRsshubRoutes } from "./rsshub-route-search";
import { resolveRsshubRoutes } from "./rsshub-route-resolver";
import {
  fetchRoute,
  extractErrorClass,
  type NormalizedFeedItem,
} from "./rsshub-client";

// ─── Types ──────────────────────────────────────────────────

export interface LiveRsshubSource {
  feed_item_id: string;
  source_kind: "rsshub_live";
  provider: "rsshub";
  title: string;
  publisher: string;
  source_url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  tags: string[];
  route_path: string;
  rsshub_feed_url: string;
  docs_url: string;
  rank: number;
  relevance_score: number;
  matched_terms: string[];
  reason: string;
  fetch_status: "ok" | "partial";
}

export interface LiveSearchResult {
  ok: boolean;
  sources: LiveRsshubSource[];
  routeCandidates: number;
  resolvedRoutes: number;
  fetchedRoutes: number;
  errors: Array<{ route_path: string; error_class: string }>;
  fallbackReason?: string;
}

// ─── Helpers ────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Strip userinfo (user:pass@) from URL to prevent credential leakage. */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Score a feed item against user intent.
 * Priority: exact entity in title > title keyword > domain > summary > recency.
 */
function scoreItem(
  item: NormalizedFeedItem,
  entityTerms: string[],
  expandedQueries: string[],
  routeScore: number
): { score: number; matchedTerms: string[] } {
  let score = 0;
  const matched: string[] = [];

  const title = (item.title || "").toLowerCase();
  const summary = (item.summary || "").toLowerCase();
  const domain = extractDomain(item.canonical_url || "")?.toLowerCase() || "";

  // Exact entity match in title (strongest)
  for (const entity of entityTerms) {
    const e = entity.toLowerCase();
    if (!e) continue;
    if (title.includes(e)) {
      score += 20;
      matched.push(entity);
    } else if (summary.includes(e)) {
      score += 8;
      matched.push(entity);
    } else if (domain.includes(e)) {
      score += 5;
      matched.push(entity);
    }
  }

  // General query term match
  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of words) {
      if (matched.some((m) => m.toLowerCase().includes(word))) continue;
      if (title.includes(word)) score += 5;
      else if (summary.includes(word)) score += 2;
    }
  }

  // Recency bonus
  if (item.published_at) {
    const ageMs = Date.now() - new Date(item.published_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours < 24) score += 3;
    else if (ageHours < 72) score += 2;
    else if (ageHours < 168) score += 1;
  }

  // Route score bonus (small)
  score += Math.min(routeScore / 10, 3);

  return { score: Math.max(0, score), matchedTerms: matched };
}

// ─── Multi-Instance Helpers ──────────────────────────────────

/**
 * Get ordered list of RSSHub base URLs to try.
 * Primary from PAYLABS_RSSHUB_BASE_URL, fallbacks from PAYLABS_RSSHUB_FALLBACK_BASE_URLS.
 * Deduplicated, trailing slashes stripped, validated as http(s).
 */
function getRsshubBaseUrls(): string[] {
  const primary =
    process.env.PAYLABS_RSSHUB_BASE_URL || "https://rsshub.rssforever.com";
  const fallbacks = (process.env.PAYLABS_RSSHUB_FALLBACK_BASE_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = [primary, ...fallbacks]
    .map((u) => u.replace(/\/+$/, ""))
    .filter((u) => /^https?:\/\//.test(u));
  return [...new Set(urls)];
}

/**
 * Try fetching a route from each RSSHub instance until one returns items.
 * Returns the first successful result with the base URL that worked.
 */
async function fetchRouteWithFallback(
  baseUrls: string[],
  routePath: string,
  maxItems: number
): Promise<{
  ok: boolean;
  result: { ok: true; items: NormalizedFeedItem[]; feed_title: string | null; feed_url: string } | null;
  baseUrlUsed: string | null;
  attempts: Array<{ host: string; error_class: string }>;
}> {
  const attempts: Array<{ host: string; error_class: string }> = [];

  for (const baseUrl of baseUrls) {
    let result;
    try {
      result = await fetchRoute(baseUrl, routePath, maxItems);
    } catch (err: unknown) {
      const host = extractHost(baseUrl);
      attempts.push({ host, error_class: extractErrorClass(err) });
      continue;
    }

    const host = extractHost(baseUrl);

    if (result.ok && result.items.length > 0) {
      // Safe log: host, route, item count — no raw payload
      console.log("[rsshub-live] route fetched", {
        host,
        route: routePath,
        items: result.items.length,
      });
      return { ok: true, result, baseUrlUsed: baseUrl, attempts };
    }

    attempts.push({
      host,
      error_class: result.ok ? "empty_feed" : result.error.slice(0, 80),
    });
  }

  // All instances failed — log safe summary
  console.warn("[rsshub-live] all instances failed", {
    route: routePath,
    attempts,
  });

  return { ok: false, result: null, baseUrlUsed: null, attempts };
}

/** Extract hostname from URL for safe logging. */
function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

// ─── Concurrency Helper ─────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Search live RSSHub feeds for relevant sources.
 *
 * Pipeline:
 * 1. Load catalog (cached)
 * 2. Search routes by query/entities
 * 3. Resolve route params
 * 4. Fetch top routes (bounded, concurrent)
 * 5. Normalize and rank items
 * 6. Return top sources
 */
export async function liveSearchRsshub(input: {
  userGoal: string;
  expandedQueries?: string[];
  entityTerms?: string[];
  negativeFilters?: string[];
  sourcePreferences?: string[];
  routeTier?: string;
  maxSources?: number;
  skipRerank?: boolean;
}): Promise<LiveSearchResult> {
  const {
    userGoal,
    expandedQueries = [],
    entityTerms = [],
    negativeFilters = [],
    routeTier = "easy",
    maxSources = Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_SOURCES) || 12,
    skipRerank = false,
  } = input;

  const baseUrls = getRsshubBaseUrls();
  const primaryBaseUrl = baseUrls[0];
  const maxItemsPerRoute =
    Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_ITEMS_PER_ROUTE) || 10;
  const concurrency =
    Number(process.env.PAYLABS_RSSHUB_LIVE_CONCURRENCY) || 4;
  const timeoutMs =
    Number(process.env.PAYLABS_RSSHUB_LIVE_TIMEOUT_MS) || 10_000;

  // Tier-based route limits
  const maxRoutesByTier: Record<string, number> = {
    easy: 4,
    normal: 8,
    advanced: 10,
  };
  const maxRoutes =
    Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_ROUTES) ||
    maxRoutesByTier[routeTier] ||
    4;

  const errors: Array<{ route_path: string; error_class: string }> = [];

  try {
    // 1. Load catalog
    const catalog = await getRsshubCatalog();
    if (catalog.length === 0) {
      return {
        ok: false,
        sources: [],
        routeCandidates: 0,
        resolvedRoutes: 0,
        fetchedRoutes: 0,
        errors: [{ route_path: "*", error_class: "catalog_empty" }],
        fallbackReason: "RSSHub catalog is empty or unavailable",
      };
    }

    // 2. Search routes
    let candidates = await searchRsshubRoutes({
      userGoal,
      expandedQueries,
      entityTerms,
      limit: maxRoutes * 5, // search wider, resolve narrower
    });

    if (candidates.length === 0) {
      return {
        ok: true,
        sources: [],
        routeCandidates: 0,
        resolvedRoutes: 0,
        fetchedRoutes: 0,
        errors,
        fallbackReason: "No matching RSSHub routes found",
      };
    }

    // 2b. Optional LLM rerank (if enabled, unless skipped by caller)
    const llmRerankEnabled = !skipRerank && process.env.PAYLABS_RSSHUB_LLM_ROUTE_RERANK === "true";
    if (llmRerankEnabled && candidates.length > maxRoutes) {
      try {
        const { rerankRouteCandidates } = await import("./rsshub-route-rerank");
        const reranked = await rerankRouteCandidates({
          candidates,
          userGoal,
          expandedQueries,
          entityTerms,
          routeTier,
          maxRoutes,
        });
        if (reranked.selectedCandidates.length > 0) {
          candidates = reranked.selectedCandidates;
        }
        // If rerank returned empty, fall through to deterministic candidates
      } catch (err: unknown) {
        console.warn("[rsshub-live] LLM route rerank failed, using deterministic", {
          error: err instanceof Error ? err.message.slice(0, 80) : "unknown",
        });
        // Fall through to deterministic candidates
      }
    }

    // 3. Resolve route params
    const resolved = await resolveRsshubRoutes({
      candidates,
      query: userGoal,
      entityTerms,
      baseUrl: primaryBaseUrl,
      limit: maxRoutes,
    });

    if (resolved.length === 0) {
      return {
        ok: true,
        sources: [],
        routeCandidates: candidates.length,
        resolvedRoutes: 0,
        fetchedRoutes: 0,
        errors,
        fallbackReason: "Could not resolve RSSHub route parameters",
      };
    }

    // 4. Fetch routes with multi-instance fallback
    const fetchResults = await mapWithConcurrency(
      resolved,
      async (route) => {
        const fb = await fetchRouteWithFallback(
          baseUrls,
          route.resolvedPath,
          maxItemsPerRoute
        );

        // Collect errors from all attempts
        for (const attempt of fb.attempts) {
          errors.push({
            route_path: route.resolvedPath,
            error_class: attempt.error_class,
          });
        }

        if (fb.ok && fb.result && fb.baseUrlUsed) {
          return {
            route,
            result: fb.result,
            baseUrlUsed: fb.baseUrlUsed,
          };
        }

        return { route, result: null, baseUrlUsed: null };
      },
      concurrency
    );

    // 5. Normalize items
    const allSources: LiveRsshubSource[] = [];
    let fetchedRoutes = 0;

    for (const { route, result, baseUrlUsed } of fetchResults) {
      if (!result || !result.ok) {
        continue;
      }
      fetchedRoutes++;

      const items = (result as { items: NormalizedFeedItem[] }).items;
      for (const item of items) {
        // Strip raw payload — only safe fields
        const scoring = scoreItem(
          item,
          entityTerms,
          expandedQueries,
          route.route.heat
        );

        // Filter out low-score unrelated items from relevant routes
        const minItemScore = routeTier === "advanced" ? 2 : routeTier === "normal" ? 2 : 1;
        if (scoring.score < minItemScore) continue;

        const sourceUrl = item.canonical_url || "";
        if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) continue;

        // Negative filter
        const titleLower = (item.title || "").toLowerCase();
        const summaryLower = (item.summary || "").toLowerCase();
        const isNegative = negativeFilters.some(
          (nf) =>
            nf.length > 2 &&
            (titleLower.includes(nf.toLowerCase()) ||
              summaryLower.includes(nf.toLowerCase()))
        );
        if (isNegative) continue;

        const feedItemId = `rsshub_live:${sha256(route.resolvedPath + "|" + sourceUrl).slice(0, 16)}`;

        // rsshub_feed_url uses the ACTUAL working instance, not the primary
        const actualFeedUrl = baseUrlUsed
          ? sanitizeUrl(`${baseUrlUsed.replace(/\/+$/, "")}${route.resolvedPath}`)
          : sanitizeUrl(route.rsshubFeedUrl);

        allSources.push({
          feed_item_id: feedItemId,
          source_kind: "rsshub_live",
          provider: "rsshub",
          title: item.title || "(untitled)",
          publisher: item.publisher || "",
          source_url: sourceUrl,
          domain: extractDomain(sourceUrl),
          summary: (item.summary || "").slice(0, 500),
          author: item.author_name || "",
          published_at: item.published_at || null,
          tags: item.tags || [],
          route_path: route.resolvedPath,
          rsshub_feed_url: actualFeedUrl,
          docs_url: route.docsUrl,
          rank: 0, // set below
          relevance_score: 0, // set below
          matched_terms: scoring.matchedTerms,
          reason: route.safeReason,
          fetch_status: "ok",
          _score: scoring.score, // preserve original score for sorting
        } as LiveRsshubSource & { _score: number });
      }
    }

    // 6. Dedupe by URL
    const seen = new Set<string>();
    const deduped = allSources.filter((s) => {
      const key = s.source_url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 7. Sort by ORIGINAL scoreItem score (not recomputed)
    deduped.sort((a, b) => {
      const aScore = (a as LiveRsshubSource & { _score: number })._score ?? 0;
      const bScore = (b as LiveRsshubSource & { _score: number })._score ?? 0;
      return bScore - aScore;
    });

    // 8. Assign ranks and normalize scores
    const topSources = deduped.slice(0, maxSources);
    const topScores = topSources.map((s) => (s as LiveRsshubSource & { _score: number })._score ?? 0);
    const maxScore = Math.max(topScores[0] ?? 1, 1);

    topSources.forEach((s, i) => {
      const rawScore = (s as LiveRsshubSource & { _score: number })._score ?? 0;
      s.rank = i + 1;
      s.relevance_score = Math.min(rawScore / maxScore, 1);
      // Strip internal _score field before returning
      delete (s as unknown as Record<string, unknown>)._score;
    });

    return {
      ok: true,
      sources: topSources,
      routeCandidates: candidates.length,
      resolvedRoutes: resolved.length,
      fetchedRoutes,
      errors,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      sources: [],
      routeCandidates: 0,
      resolvedRoutes: 0,
      fetchedRoutes: 0,
      errors: [
        {
          route_path: "*",
          error_class:
            err instanceof Error ? err.message.slice(0, 80) : "unknown",
        },
      ],
      fallbackReason: "Live RSSHub search failed",
    };
  }
}

/**
 * Compute final relevance score for sorting.
 */
function computeFinalScore(
  source: LiveRsshubSource,
  entityTerms: string[],
  expandedQueries: string[]
): number {
  let score = 0;
  const title = source.title.toLowerCase();
  const summary = source.summary.toLowerCase();

  for (const entity of entityTerms) {
    const e = entity.toLowerCase();
    if (title.includes(e)) score += 20;
    else if (summary.includes(e)) score += 8;
  }

  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of words) {
      if (title.includes(word)) score += 5;
      else if (summary.includes(word)) score += 2;
    }
  }

  if (source.published_at) {
    const ageHours =
      (Date.now() - new Date(source.published_at).getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) score += 3;
    else if (ageHours < 72) score += 2;
    else if (ageHours < 168) score += 1;
  }

  return Math.max(0, score);
}
