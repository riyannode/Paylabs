/**
 * Signal Scout Basics Handler
 *
 * Deterministic-only source discovery for EASY tier.
 * No LLM. No reranking. Pure keyword/entity scoring.
 *
 * LIVE-ONLY: Never falls back to DB. If RSSHub returns no sources,
 * returns empty candidates with live_diagnostics.
 *
 * Flow:
 *   1. RSSHub live search (deterministic API call)
 *   2. Keyword/entity match scoring
 *   3. Sort by score → ranked_candidates
 *
 * Macro-node: discovery_planner
 * Requires LLM: no
 */

import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { resolveTopicRoutes } from "@/lib/rsshub/topic-routes";

// ─── Stopwords — generic words that should never count as relevance signals ──
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

// ─── Meaningful short tokens — never filtered by length ─────
const MEANINGFUL_SHORT_TOKENS = new Set([
  "ai", "ml", "llm", "btc", "eth", "sol", "nft", "dao", "dex",
  "api", "usdc", "x402", "evm", "l2", "cefi", "gpt", "cv",
]);

// ─── Boundary-aware entity matching ────────────────────────
const MEANINGFUL_SHORT_TOKENS_LOCAL = new Set([
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
  if (t.length <= 3 || MEANINGFUL_SHORT_TOKENS_LOCAL.has(t)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegexLocal(t)}([^a-z0-9]|$)`, "i").test(text);
  }
  return text.includes(t);
}

// ─── Deterministic Scoring ─────────────────────────────────

function scoreItem(
  item: Record<string, unknown>,
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[] = [],
  sourcePreferences: string[] = []
): { score: number; entityHit: boolean } {
  let score = 0;
  let entityHit = false;
  const title = String(item.title || "").toLowerCase();
  const summary = String(item.summary || "").toLowerCase();
  const publisher = String(item.publisher || "").toLowerCase();
  const authorName = String(item.author_name || "").toLowerCase();
  const domain = String(item.domain || "").toLowerCase();
  const sourceUrl = String(item.source_url || item.url || "").toLowerCase();
  const routePath = String(item.route_path || "").toLowerCase();
  const urlPath = (() => { try { return new URL(sourceUrl).pathname.toLowerCase(); } catch { return ""; } })();

  // 1. Exact entity match (strongest signal) — weighted 2x
  for (const entity of entityTerms) {
    const lower = entity.toLowerCase();
    if (!lower) continue;
    let matched = false;
    if (hasEntityTerm(title, lower)) { score += 20; matched = true; }
    else if (hasEntityTerm(summary, lower)) { score += 8; matched = true; }
    else if (hasEntityTerm(sourceUrl, lower)) { score += 16; matched = true; }
    else if (hasEntityTerm(routePath, lower)) { score += 14; matched = true; }
    else if (hasEntityTerm(urlPath, lower)) { score += 12; matched = true; }
    else if (hasEntityTerm(authorName, lower)) { score += 6; matched = true; }
    else if (hasEntityTerm(domain, lower)) { score += 4; matched = true; }
    if (matched) entityHit = true;
  }

  // 2. Keyword overlap with queries (skip stopwords and short words)
  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => (w.length > 3 || MEANINGFUL_SHORT_TOKENS.has(w)) && !STOPWORDS.has(w));
    for (const word of words) {
      if (title.includes(word)) score += 3;
      if (summary.includes(word)) score += 1;
      if (publisher.includes(word)) score += 1;
    }
  }

  // 3. Recency bonus (prefer newer, only if already relevant)
  if (score > 0) {
    const publishedAt = item.published_at ? new Date(item.published_at as string).getTime() : 0;
    if (publishedAt > 0) {
      const ageHours = (Date.now() - publishedAt) / (1000 * 60 * 60);
      if (ageHours < 24) score += 3;
      else if (ageHours < 72) score += 2;
      else if (ageHours < 168) score += 1;
    }
  }

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

  return { score, entityHit };
}

// ─── Live RSSHub Search ─────────────────────────────────────

type RankedCandidate = {
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
};

type LiveDiagnostics = {
  route_candidates: number;
  resolved_routes: number;
  fetched_routes: number;
  topic_routes_count: number;
  errors: Array<{ route_path: string; error_class: string }>;
  fallback_reason: string | null;
};

type LiveSearchOutput = {
  candidates: RankedCandidate[];
  diagnostics: LiveDiagnostics;
};

async function searchRsshubLive(
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[],
  routeTier: string
): Promise<LiveSearchOutput> {
  const emptyDiagnostics: LiveDiagnostics = {
    route_candidates: 0,
    resolved_routes: 0,
    fetched_routes: 0,
    topic_routes_count: 0,
    errors: [],
    fallback_reason: null,
  };

  try {
    const { liveSearchRsshub } = await import("@/lib/rsshub/rsshub-live-search");

    const userGoal = expandedQueries.length > 0
      ? expandedQueries.join(" ")
      : entityTerms.join(" ") || "";

    const result = await liveSearchRsshub({
      userGoal,
      expandedQueries,
      entityTerms,
      negativeFilters,
      routeTier,
      maxSources: 20,
      skipRerank: true,
    });

    const diagnostics: LiveDiagnostics = {
      route_candidates: result.routeCandidates,
      resolved_routes: result.resolvedRoutes,
      fetched_routes: result.fetchedRoutes,
      topic_routes_count: 0, // set by handler after topic fetch
      errors: result.errors || [],
      fallback_reason: result.fallbackReason || null,
    };

    // Safe diagnostic log — no raw payloads, no secrets
    console.log(JSON.stringify({
      log: "[signal_scout_basics] live_diagnostics",
      route_candidates: diagnostics.route_candidates,
      resolved_routes: diagnostics.resolved_routes,
      fetched_routes: diagnostics.fetched_routes,
      error_count: diagnostics.errors.length,
      error_classes: diagnostics.errors.map((e) => e.error_class).slice(0, 5),
      fallback_reason: diagnostics.fallback_reason,
      source_count: result.sources.length,
    }));

    if (!result.ok || result.sources.length === 0) {
      return { candidates: [], diagnostics };
    }

    // Validate every live source has required fields
    const candidates: RankedCandidate[] = result.sources
      .filter((s) =>
        s.source_kind === "rsshub_live" &&
        s.provider === "rsshub" &&
        !!s.route_path &&
        !!s.rsshub_feed_url &&
        /^https?:\/\//.test(s.source_url)
      )
      .map((s) => ({
        feed_item_id: s.feed_item_id,
        title: s.title,
        publisher: s.publisher,
        source_kind: "rsshub_live" as const,
        provider: "rsshub" as const,
        source_url: s.source_url,
        domain: s.domain,
        summary: s.summary,
        author: s.author,
        published_at: s.published_at,
        route_path: s.route_path,
        rsshub_feed_url: s.rsshub_feed_url,
        docs_url: s.docs_url,
        rank: s.rank,
        relevance_score: s.relevance_score,
        reason: s.reason,
      }));

    return { candidates, diagnostics };
  } catch (err: unknown) {
    console.warn("[signal_scout_basics] RSSHub live search failed", {
      error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
    });
    return {
      candidates: [],
      diagnostics: {
        ...emptyDiagnostics,
        errors: [{ route_path: "*", error_class: err instanceof Error ? err.message.slice(0, 80) : "unknown" }],
        fallback_reason: "Live RSSHub search threw an exception",
      },
    };
  }
}

// ─── Topic Route Fetching ───────────────────────────────────

/**
 * Build ordered list of RSSHub base URLs (same logic as rsshub-live-search).
 */
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

/**
 * Fetch a single topic route with multi-instance fallback.
 */
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
  const { fetchRoute } = await import("@/lib/rsshub/rsshub-client");
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

/**
 * Fetch topic routes directly (all static paths, no param resolution needed).
 * Runs in parallel with regular live search.
 */
async function fetchTopicRoutesLive(
  userGoal: string,
  entityTerms: string[],
  expandedQueries: string[],
  negativeFilters: string[],
  sourcePreferences: string[]
): Promise<RankedCandidate[]> {
  try {
    const topicRoutes = resolveTopicRoutes(userGoal, entityTerms, 8);
    if (topicRoutes.length === 0) return [];

    const maxItemsPerRoute =
      Number(process.env.PAYLABS_RSSHUB_LIVE_MAX_ITEMS_PER_ROUTE) || 10;

    // Fetch all topic routes concurrently (max 4 at a time)
    const concurrency = 4;
    const allCandidates: RankedCandidate[] = [];
    let index = 0;

    async function worker() {
      while (index < topicRoutes.length) {
        const i = index++;
        const route = topicRoutes[i];
        const result = await fetchTopicRouteItems(route.path, maxItemsPerRoute);

        if (!result.ok || result.items.length === 0) continue;

        for (const item of result.items) {
          const { score: local_score, entityHit } = scoreItem(
            {
              title: item.title,
              summary: item.summary,
              publisher: item.publisher,
              author_name: item.author_name,
              domain: (() => {
                try {
                  return new URL(item.canonical_url).hostname;
                } catch {
                  return "";
                }
              })(),
              source_url: item.canonical_url,
              route_path: route.path,
            } as Record<string, unknown>,
            expandedQueries,
            entityTerms,
            negativeFilters,
            sourcePreferences
          );

          // Item-level relevance gate: min score >= 3
          const MIN_SCORE = 3;
          if (local_score < MIN_SCORE && !entityHit) continue;

          const sourceUrl = item.canonical_url || "";
          if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) continue;

          // Negative filter check
          const titleLower = (item.title || "").toLowerCase();
          const summaryLower = (item.summary || "").toLowerCase();
          const isNegative = negativeFilters.some(
            (nf) =>
              nf.length > 2 &&
              (titleLower.includes(nf.toLowerCase()) ||
                summaryLower.includes(nf.toLowerCase()))
          );
          if (isNegative) continue;

          const feedItemId = `topic:${route.path}:${sourceUrl.slice(0, 80)}`;

          allCandidates.push({
            feed_item_id: feedItemId,
            title: item.title || "(untitled)",
            publisher: item.publisher || route.label,
            source_kind: "rsshub_live",
            provider: "rsshub",
            source_url: sourceUrl,
            domain: (() => {
              try {
                return new URL(sourceUrl).hostname;
              } catch {
                return null;
              }
            })(),
            summary: (item.summary || "").slice(0, 500),
            author: item.author_name || "",
            published_at: item.published_at || null,
            route_path: route.path,
            rsshub_feed_url: result.feedUrl || "",
            docs_url: `https://docs.rsshub.app/routes#${encodeURIComponent(route.path.split("/")[1])}`,
            rank: 0,
            relevance_score: 0,
            reason: `topic:${route.category}/${route.subcategory}`,
          });
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, topicRoutes.length) },
      () => worker()
    );
    await Promise.all(workers);

    console.log(JSON.stringify({
      log: "[signal_scout_basics] topic_routes_fetched",
      topic_count: topicRoutes.length,
      candidates: allCandidates.length,
      categories: [...new Set(topicRoutes.map((r) => r.category))],
    }));

    return allCandidates;
  } catch (err: unknown) {
    console.warn("[signal_scout_basics] topic route fetch failed", {
      error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
    });
    return [];
  }
}

// ─── Handler ────────────────────────────────────────────────

export const signalScoutBasicsHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const {
    expanded_queries,
    entity_terms,
    negative_filters,
    source_preferences,
    routeTier,
  } = input.payload as {
    expanded_queries: string[];
    entity_terms: string[];
    negative_filters?: string[];
    source_preferences?: string[];
    routeTier?: DelegatedRouteTier;
  };

  // ── Step 1: RSSHub live search (always live-only, never DB fallback) ──
  const liveEnabled = process.env.PAYLABS_RSSHUB_LIVE_ENABLED !== "false";

  if (!liveEnabled) {
    return {
      ok: true,
      serviceName: "signal_scout_basics",
      data: {
        ranked_candidates: [],
        top_candidates: [],
        quick_relevance_notes: ["RSSHub live search is disabled."],
        safe_signal_summary: "[basic] RSSHub live disabled by env.",
        retrieval_mode: "rsshub_live_empty",
        live_diagnostics: {
          route_candidates: 0,
          resolved_routes: 0,
          fetched_routes: 0,
          topic_routes_count: 0,
          errors: [{ route_path: "*", error_class: "live_disabled" }],
          fallback_reason: "PAYLABS_RSSHUB_LIVE_ENABLED is false",
        },
      },
      safeSummary: "[basic] RSSHub live disabled.",
      settled: false,
      error: null,
    };
  }

  // ── Step 1: Run regular live search + topic routes in parallel ──
  const [liveResult, topicCandidates] = await Promise.all([
    searchRsshubLive(
      expanded_queries || [],
      entity_terms || [],
      negative_filters || [],
      routeTier || "easy"
    ),
    fetchTopicRoutesLive(
      (expanded_queries || []).join(" ") || (entity_terms || []).join(" "),
      entity_terms || [],
      expanded_queries || [],
      negative_filters || [],
      source_preferences || []
    ),
  ]);

  const { candidates: liveResults, diagnostics } = liveResult;

  // ── Step 2: Merge topic candidates with regular live results ──
  // Dedupe by source_url — topic routes take priority (appear first)
  const seenUrls = new Set<string>();
  const merged: RankedCandidate[] = [];

  for (const tc of topicCandidates) {
    const key = tc.source_url.toLowerCase();
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      merged.push(tc);
    }
  }
  for (const lr of liveResults) {
    const key = lr.source_url.toLowerCase();
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      merged.push(lr);
    }
  }

  // ── Step 3: Rescore with deterministic keyword match + item-level gate ──
  // Update diagnostics with topic route count
  diagnostics.topic_routes_count = topicCandidates.length;

  if (merged.length > 0) {
    const MIN_SCORE = 3; // Minimum raw score to be considered relevant

    const rescored = merged
      .map((item) => {
        const { score: local_score, entityHit } = scoreItem(
          item as unknown as Record<string, unknown>,
          expanded_queries || [],
          entity_terms || [],
          negative_filters || [],
          source_preferences || []
        );
        return { ...item, local_score, entityHit };
      })
      // Filter: must have entity match OR high keyword score
      .filter((item) => item.entityHit || item.local_score >= MIN_SCORE)
      .sort((a, b) => b.local_score - a.local_score)
      .map((item, i) => ({
        ...item,
        rank: i + 1,
        relevance_score: item.local_score > 0
          ? Math.min(item.local_score / 30, 1)
          : item.relevance_score,
      }));

    return {
      ok: true,
      serviceName: "signal_scout_basics",
      data: {
        ranked_candidates: rescored,
        top_candidates: rescored.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: rescored.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `[basic] Live RSSHub: ${rescored.length} source(s) found${topicCandidates.length > 0 ? `, ${topicCandidates.length} from topic routes` : ""}.`,
        retrieval_mode: "rsshub_live",
        source_strategy: topicCandidates.length > 0 ? "topic_routes" : "catalog",
        topic_routes_count: topicCandidates.length,
        live_diagnostics: diagnostics,
      },
      safeSummary: `[basic] Live RSSHub: ${rescored.length} source(s) found.`,
      settled: false,
      error: null,
    };
  }

  // ── Step 3: No live results — return empty with diagnostics (NO DB fallback) ──
  return {
    ok: true,
    serviceName: "signal_scout_basics",
    data: {
      ranked_candidates: [],
      top_candidates: [],
      quick_relevance_notes: ["No matching live RSSHub sources found."],
      safe_signal_summary: "[basic] No live RSSHub source matched this query.",
      retrieval_mode: "rsshub_live_empty",
      live_diagnostics: diagnostics,
    },
    safeSummary: "[basic] No live RSSHub source matched this query.",
    settled: false,
    error: null,
  };
};
