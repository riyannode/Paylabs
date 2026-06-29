/**
 * RSSHub Topic Route Live Search — Shared Helper
 *
 * Fetches live feed items from curated topic routes (AI, crypto).
 * Used by both signal_scout_basics (Easy) and signal_scout (Normal/Advanced).
 *
 * Acceptance gate:
 *   entityHit || local_score >= MIN_SCORE || routeTopicHit
 *
 * routeTopicHit = route was returned by resolveTopicRoutes() for a detected
 * topic that matches the query. This allows items from /openai/news or
 * /coindesk/news to pass even when the item title doesn't contain the
 * boundary term "ai" or "crypto".
 *
 * No LLM. No secrets. No raw payload exposure.
 */

import { resolveTopicRoutes, type TopicRoute } from "./topic-routes";
import { fetchRoute } from "./rsshub-client";

// ─── Types ──────────────────────────────────────────────────

export interface TopicLiveCandidate {
  feed_item_id: string;
  title: string;
  publisher: string;
  source_kind: "rsshub_live";
  provider: "rsshub";
  source_url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  route_path: string;
  rsshub_feed_url: string;
  docs_url: string;
  rank: number;
  relevance_score: number;
  reason: string;
  topic_category: string;
  topic_subcategory: string;
}

export interface TopicLiveDiagnostics {
  detected_topics: number;
  topic_routes_count: number;
  topic_routes_fetched: number;
  topic_items_fetched: number;
  topic_items_accepted: number;
  topic_items_rejected: number;
  topic_candidates_count: number;
}

export interface TopicLiveResult {
  candidates: TopicLiveCandidate[];
  diagnostics: TopicLiveDiagnostics;
}

// ─── Scoring helpers ────────────────────────────────────────

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "how", "this", "that",
  "these", "those", "with", "from", "into", "about", "between", "through",
  "after", "before", "above", "below", "latest", "recent", "news", "update",
  "updates", "article", "articles", "story", "stories", "report", "reports",
  "blog", "post", "posts", "page", "pages", "find", "show", "search",
  "look", "give", "tell", "want", "need", "know", "please", "could",
  "would", "should", "valid", "ga", "check", "cek", "apa", "ada",
  "yang", "dan", "atau", "untuk", "dari", "dengan", "ini", "itu",
]);

const MEANINGFUL_SHORT_TOKENS = new Set([
  "ai", "ml", "llm", "btc", "eth", "sol", "nft", "dao", "dex",
  "api", "usdc", "x402", "evm", "l2", "cefi", "gpt", "cv",
]);

function escapeRegexLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Boundary-aware entity matching: short tokens must not match inside other words */
function hasEntityTerm(text: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (t.length <= 3 || MEANINGFUL_SHORT_TOKENS.has(t)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegexLocal(t)}([^a-z0-9]|$)`, "i").test(text);
  }
  return text.includes(t);
}

/**
 * Score a topic route item for relevance.
 * Returns raw score, entity hit flag, and recency bonus separately.
 */
function scoreTopicItem(
  fields: {
    title: string;
    summary: string;
    publisher: string;
    author_name: string;
    domain: string;
    source_url: string;
    route_path: string;
    published_at: string | null;
  },
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[],
  sourcePreferences: string[]
): {
  score: number;
  entityHit: boolean;
  contentEntityHit: boolean;
  structuralEntityHit: boolean;
  recencyBonus: number;
} {
  let score = 0;
  let entityHit = false;
  let contentEntityHit = false;   // title or summary match
  let structuralEntityHit = false; // url/routePath/domain/publisher/author match only
  const title = fields.title.toLowerCase();
  const summary = fields.summary.toLowerCase();
  const publisher = fields.publisher.toLowerCase();
  const authorName = fields.author_name.toLowerCase();
  const domain = fields.domain.toLowerCase();
  const sourceUrl = fields.source_url.toLowerCase();
  const routePath = fields.route_path.toLowerCase();

  // 1. Entity match — track location for scoring tiers
  for (const entity of entityTerms) {
    const lower = entity.toLowerCase();
    if (!lower) continue;
    let matched = false;
    // Content matches (strong signal)
    if (hasEntityTerm(title, lower)) { score += 20; matched = true; contentEntityHit = true; }
    else if (hasEntityTerm(summary, lower)) { score += 8; matched = true; contentEntityHit = true; }
    // Structural matches (weak signal — helps but shouldn't dominate)
    else if (hasEntityTerm(sourceUrl, lower)) { score += 4; matched = true; structuralEntityHit = true; }
    else if (hasEntityTerm(routePath, lower)) { score += 3; matched = true; structuralEntityHit = true; }
    else if (hasEntityTerm(authorName, lower)) { score += 3; matched = true; structuralEntityHit = true; }
    else if (hasEntityTerm(domain, lower)) { score += 2; matched = true; structuralEntityHit = true; }
    if (matched) entityHit = true;
  }

  // 2. Keyword overlap with queries
  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => (w.length > 3 || MEANINGFUL_SHORT_TOKENS.has(w)) && !STOPWORDS.has(w));
    for (const word of words) {
      if (title.includes(word)) score += 3;
      if (summary.includes(word)) score += 1;
      if (publisher.includes(word)) score += 1;
    }
  }

  // 3. Recency bonus — computed separately, always added
  let recencyBonus = 0;
  if (fields.published_at) {
    try {
      const ageHours = (Date.now() - new Date(fields.published_at).getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) recencyBonus = 3;
      else if (ageHours < 72) recencyBonus = 2;
      else if (ageHours < 168) recencyBonus = 1;
    } catch { /* invalid date */ }
  }
  score += recencyBonus;

  // 4. Publisher diversity bonus
  if (publisher && publisher.length > 0) score += 1;

  // 5. Negative filter penalty
  for (const nf of negativeFilters) {
    const nfLower = nf.toLowerCase();
    if (title.includes(nfLower) || summary.includes(nfLower) || publisher.includes(nfLower)) {
      score -= 5;
    }
  }

  // 6. Source preference boost
  for (const sp of sourcePreferences) {
    const spLower = sp.toLowerCase();
    if (title.includes(spLower) || summary.includes(spLower) || publisher.includes(spLower)) {
      score += 2;
    }
  }

  return { score: Math.max(0, score), entityHit, contentEntityHit, structuralEntityHit, recencyBonus };
}

/**
 * Compute final relevance_score for a topic candidate.
 *
 * Scoring tiers:
 * - contentEntityHit (title/summary match) + high localScore → 0.65–0.90
 * - entityHit with only structural match (url/routePath/domain) → 0.45–0.65
 * - keyword score >= 3 → 0.40–0.65
 * - routeTopicHit only → 0.35–0.48
 *
 * Rules:
 * - routeTopicHit-only never outranks contentEntityHit
 * - URL/routePath-only entity hit never reaches 0.95
 */
function computeRelevanceScore({
  localScore,
  entityHit,
  contentEntityHit,
  structuralEntityHit,
  routeTopicHit,
  recencyBonus,
}: {
  localScore: number;
  entityHit: boolean;
  contentEntityHit: boolean;
  structuralEntityHit: boolean;
  routeTopicHit: boolean;
  recencyBonus: number;
}): number {
  if (contentEntityHit && localScore >= 10) {
    // Strong content match: title or summary contains entity term
    return Math.min(0.65 + (localScore - 10) * 0.01 + recencyBonus * 0.02, 0.90);
  }
  if (entityHit && localScore >= 3) {
    // Entity hit but only structural (url/routePath/domain) — cap at 0.65
    return Math.min(0.45 + localScore * 0.01 + recencyBonus * 0.02, 0.65);
  }
  if (localScore >= 3) {
    // Moderate keyword match (no entity hit)
    return Math.min(0.40 + localScore * 0.02 + recencyBonus * 0.02, 0.65);
  }
  if (routeTopicHit) {
    // Route-level match only: item from correct topic route but no entity/keyword hit
    // Conservative: never outrank content entity matches
    return Math.min(0.35 + recencyBonus * 0.03, 0.48);
  }
  return 0.30;
}

// ─── Multi-instance helpers ─────────────────────────────────

function getTopicBaseUrls(): string[] {
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

async function fetchTopicRouteItems(
  routePath: string,
  maxItems: number
): Promise<{
  ok: boolean;
  items: Array<{
    title: string;
    summary: string;
    canonical_url: string;
    publisher: string;
    author_name: string;
    published_at: string | null;
    tags: string[];
  }>;
  feedUrl: string | null;
}> {
  const baseUrls = getTopicBaseUrls();

  for (const baseUrl of baseUrls) {
    try {
      const result = await fetchRoute(baseUrl, routePath, maxItems);
      if (result.ok && result.items.length > 0) {
        return {
          ok: true,
          items: result.items,
          feedUrl: `${baseUrl.replace(/\/+$/, "")}${routePath}`,
        };
      }
    } catch {
      continue;
    }
  }
  return { ok: false, items: [], feedUrl: null };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Fetch live feed items from curated topic routes.
 * Runs in parallel with regular live search.
 *
 * Acceptance gate: entityHit || local_score >= MIN_SCORE || routeTopicHit
 *
 * routeTopicHit means: this item came from a topic route that was selected
 * by resolveTopicRoutes() for a detected topic matching the query.
 * e.g. /openai/news for AI query, /coindesk/news for crypto query.
 * Items from these routes are accepted even without item-level entity match,
 * because the ROUTE itself is the relevance signal.
 */
export async function fetchTopicRoutesLiveSources(input: {
  userGoal: string;
  entityTerms: string[];
  expandedQueries: string[];
  negativeFilters: string[];
  sourcePreferences: string[];
  maxRoutes?: number;
  maxItemsPerRoute?: number;
  callerTag?: string;
}): Promise<TopicLiveResult> {
  const {
    userGoal,
    entityTerms,
    expandedQueries,
    negativeFilters,
    sourcePreferences,
    maxRoutes = 8,
    maxItemsPerRoute: inputMaxItems,
    callerTag = "topic_live",
  } = input;

  const emptyDiagnostics: TopicLiveDiagnostics = {
    detected_topics: 0,
    topic_routes_count: 0,
    topic_routes_fetched: 0,
    topic_items_fetched: 0,
    topic_items_accepted: 0,
    topic_items_rejected: 0,
    topic_candidates_count: 0,
  };

  try {
    const topicRoutes = resolveTopicRoutes(userGoal, entityTerms, maxRoutes);
    if (topicRoutes.length === 0) {
      return { candidates: [], diagnostics: emptyDiagnostics };
    }

    // Build set of detected topic categories for routeTopicHit
    const detectedCategories = new Set(topicRoutes.map((r) => r.category));

    const maxItemsPerRoute =
      inputMaxItems ||
      Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_ITEMS_PER_ROUTE) || 10;

    const MIN_SCORE = 3;

    // Fetch all topic routes concurrently (max 4 at a time)
    const concurrency = 4;
    const allCandidates: TopicLiveCandidate[] = [];
    let itemsFetched = 0;
    let itemsAccepted = 0;
    let itemsRejected = 0;
    let routesFetched = 0;
    let index = 0;

    async function worker() {
      while (index < topicRoutes.length) {
        const i = index++;
        const route = topicRoutes[i];
        const result = await fetchTopicRouteItems(route.path, maxItemsPerRoute);

        if (!result.ok || result.items.length === 0) continue;
        routesFetched++;
        itemsFetched += result.items.length;

        // routeTopicHit: route.category matches a detected topic
        const routeTopicHit = detectedCategories.has(route.category);

        for (const item of result.items) {
          const sourceUrl = item.canonical_url || "";
          // Basic validity: must have URL, title
          if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) {
            itemsRejected++;
            continue;
          }
          if (!item.title || item.title.trim().length === 0) {
            itemsRejected++;
            continue;
          }

          const domain = (() => {
            try { return new URL(sourceUrl).hostname; } catch { return ""; }
          })();
          if (!domain) {
            itemsRejected++;
            continue;
          }

          // Negative filter check
          const titleLower = (item.title || "").toLowerCase();
          const summaryLower = (item.summary || "").toLowerCase();
          const isNegative = negativeFilters.some(
            (nf) =>
              nf.length > 2 &&
              (titleLower.includes(nf.toLowerCase()) ||
                summaryLower.includes(nf.toLowerCase()))
          );
          if (isNegative) {
            itemsRejected++;
            continue;
          }

          // Score the item
          const { score: local_score, entityHit, contentEntityHit, structuralEntityHit, recencyBonus } = scoreTopicItem(
            {
              title: item.title || "",
              summary: item.summary || "",
              publisher: item.publisher || "",
              author_name: item.author_name || "",
              domain,
              source_url: sourceUrl,
              route_path: route.path,
              published_at: item.published_at || null,
            },
            expandedQueries,
            entityTerms,
            negativeFilters,
            sourcePreferences
          );

          // Acceptance gate: entityHit || keyword score || routeTopicHit
          if (!entityHit && local_score < MIN_SCORE && !routeTopicHit) {
            itemsRejected++;
            continue;
          }

          // Compute meaningful relevance_score
          const relevanceScore = computeRelevanceScore({
            localScore: local_score,
            entityHit,
            contentEntityHit,
            structuralEntityHit,
            routeTopicHit,
            recencyBonus,
          });

          const feedItemId = `topic:${route.path}:${sourceUrl.slice(0, 80)}`;

          allCandidates.push({
            feed_item_id: feedItemId,
            title: item.title || "(untitled)",
            publisher: item.publisher || route.label,
            source_kind: "rsshub_live",
            provider: "rsshub",
            source_url: sourceUrl,
            domain,
            summary: (item.summary || "").slice(0, 500),
            author: item.author_name || "",
            published_at: item.published_at || null,
            route_path: route.path,
            rsshub_feed_url: result.feedUrl || "",
            docs_url: `https://docs.rsshub.app/routes#${encodeURIComponent(route.path.split("/")[1])}`,
            rank: 0, // assigned below after sort
            relevance_score: relevanceScore,
            reason: `topic_route:${route.category}/${route.subcategory}`,
            topic_category: route.category,
            topic_subcategory: route.subcategory,
          });
          itemsAccepted++;
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, topicRoutes.length) },
      () => worker()
    );
    await Promise.all(workers);

    // Sort by relevance_score descending, then by recency
    allCandidates.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score;
      const aTime = a.published_at ? new Date(a.published_at).getTime() : 0;
      const bTime = b.published_at ? new Date(b.published_at).getTime() : 0;
      return bTime - aTime;
    });

    // Assign ranks
    allCandidates.forEach((c, i) => { c.rank = i + 1; });

    const detectedTopics = new Set(topicRoutes.map((r) => r.category));

    console.log(JSON.stringify({
      log: `[${callerTag}] topic_routes_fetched`,
      detected_topics: [...detectedTopics],
      topic_routes_count: topicRoutes.length,
      topic_routes_fetched: routesFetched,
      topic_items_fetched: itemsFetched,
      topic_items_accepted: itemsAccepted,
      topic_items_rejected: itemsRejected,
      topic_candidates_count: allCandidates.length,
    }));

    return {
      candidates: allCandidates,
      diagnostics: {
        detected_topics: detectedTopics.size,
        topic_routes_count: topicRoutes.length,
        topic_routes_fetched: routesFetched,
        topic_items_fetched: itemsFetched,
        topic_items_accepted: itemsAccepted,
        topic_items_rejected: itemsRejected,
        topic_candidates_count: allCandidates.length,
      },
    };
  } catch (err: unknown) {
    console.warn(`[${callerTag}] topic route fetch failed`, {
      error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
    });
    return { candidates: [], diagnostics: emptyDiagnostics };
  }
}
