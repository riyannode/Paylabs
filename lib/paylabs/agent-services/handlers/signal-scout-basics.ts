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
import { fetchTopicRoutesLiveSources } from "@/lib/paylabs/rsshub/rsshub-topic-live-search";
import { detectTopics } from "@/lib/paylabs/rsshub/topic-routes";
import {
  passesAiSourceGuard,
  passesCryptoSourceGuard,
  isGenericCatchAllSource,
} from "@/lib/paylabs/rsshub/topic-source-guards";

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
    const { liveSearchRsshub } = await import("@/lib/paylabs/rsshub/rsshub-live-search");

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

// ─── Topic Route Fetching (delegated to shared helper) ──────
// fetchTopicRoutesLiveSources imported from @/lib/paylabs/rsshub/rsshub-topic-live-search

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
  const [liveResult, topicResult] = await Promise.all([
    searchRsshubLive(
      expanded_queries || [],
      entity_terms || [],
      negative_filters || [],
      routeTier || "easy"
    ),
    fetchTopicRoutesLiveSources({
      userGoal: (expanded_queries || []).join(" ") || (entity_terms || []).join(" "),
      entityTerms: entity_terms || [],
      expandedQueries: expanded_queries || [],
      negativeFilters: negative_filters || [],
      sourcePreferences: source_preferences || [],
      callerTag: "signal_scout_basics",
    }),
  ]);

  const { candidates: liveResults, diagnostics } = liveResult;
  const topicCandidates = topicResult.candidates;

  // ── Step 2: Merge topic candidates with regular live results ──
  // Dedupe by source_url — topic routes take priority (appear first)
  const seenUrls = new Set<string>();
  const merged: Array<RankedCandidate & { _isTopicCandidate?: boolean }> = [];
  const topicUrlSet = new Set(topicCandidates.map((tc) => tc.source_url.toLowerCase()));

  for (const tc of topicCandidates) {
    const key = tc.source_url.toLowerCase();
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      merged.push({ ...tc, _isTopicCandidate: true });
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
  diagnostics.topic_routes_count = topicResult.diagnostics.topic_routes_count;

  // Detect query topics for domain guard on non-topic candidates
  const queryGoalText = (expanded_queries || []).join(" ") || (entity_terms || []).join(" ");
  const detectedTopics = detectTopics(queryGoalText, entity_terms || []);
  const queryHasAiTopic = detectedTopics.some((t) => t.category === "ai");
  const queryHasCryptoTopic = detectedTopics.some((t) => t.category === "crypto");

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
      // Filter: topic candidates pass unconditionally; non-topic need entity/keyword gate
      // Also reject Wikipedia current-events and wrong-domain sources for AI/crypto queries
      .filter((item) => {
        const url = (item.source_url || "").toLowerCase();
        const routePath = (item.route_path || "").toLowerCase();
        const domain = (item.domain || "").toLowerCase();
        const title = (item.title || "").toLowerCase();
        const summary = (item.summary || "").toLowerCase();

        // Reject generic catch-all (Wikipedia current-events) for AI/crypto queries
        if ((queryHasAiTopic || queryHasCryptoTopic) && isGenericCatchAllSource({ domain, routePath, url })) {
          return false;
        }
        // Topic candidates already passed topic-level acceptance — keep them
        if (item._isTopicCandidate) return true;
        // Non-topic candidates: apply domain guard for AI/crypto queries
        if (queryHasAiTopic && !passesAiSourceGuard({ domain, routePath, title, summary })) {
          return false;
        }
        if (queryHasCryptoTopic && !passesCryptoSourceGuard({ domain, routePath, title, summary })) {
          return false;
        }
        // Non-topic candidates need entity match OR keyword score
        return item.entityHit || item.local_score >= MIN_SCORE;
      })
      .sort((a, b) => {
        // Topic candidates first, then by score
        if (a._isTopicCandidate && !b._isTopicCandidate) return -1;
        if (!a._isTopicCandidate && b._isTopicCandidate) return 1;
        return b.local_score - a.local_score;
      })
      .map((item, i) => ({
        ...item,
        rank: i + 1,
        relevance_score: item._isTopicCandidate
          ? Math.max(item.relevance_score, 0.35) // topic candidates get minimum 0.35
          : item.local_score > 0
            ? Math.min(item.local_score / 30, 1)
            : item.relevance_score,
      }));

    // Only return if rescored has results; otherwise fall through to Tavily fallback
    if (rescored.length > 0) {
      return {
        ok: true,
        serviceName: "signal_scout_basics",
        data: {
          ranked_candidates: rescored,
          top_candidates: rescored.slice(0, 3).map((r) => r.feed_item_id),
          quick_relevance_notes: rescored.slice(0, 5).map((r) => r.reason),
          safe_signal_summary: `[basic] Live RSSHub: ${rescored.length} source(s) found${topicCandidates.length > 0 ? `, ${topicCandidates.length} from topic routes` : ""}.`,
          retrieval_mode: "rsshub_live",
          source_strategy: topicResult.candidates.length > 0 && liveResults.length > 0
            ? "topic_routes_plus_catalog"
            : topicResult.candidates.length > 0
              ? "topic_routes"
              : "catalog",
          topic_routes_count: topicResult.diagnostics.topic_routes_count,
          topic_candidates_count: topicResult.candidates.length,
          live_diagnostics: diagnostics,
        },
        safeSummary: `[basic] Live RSSHub: ${rescored.length} source(s) found.`,
        settled: false,
        error: null,
      };
    }
    // rescored.length === 0: fall through to Tavily fallback below
  }

  // ── Step 2b: Tavily fallback for AI/Crypto when RSSHub returns 0 ──
  // Check after ALL RSSHub filtering (merged + rescored) to catch cases where
  // merged had items but they were all filtered out by scoring/domain guards.
  const hasRelevantTopic = queryHasAiTopic || queryHasCryptoTopic;
  if (hasRelevantTopic) {
    const tavilyEnabled = process.env.PAYLABS_TAVILY_ENABLED === "true";
    const tavilyKeyExists = !!(process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY.length > 0);

    if (tavilyEnabled && tavilyKeyExists) {
      try {
        const { isTavilyEnabled, fetchTavilyLiveSources } = await import(
          "@/lib/paylabs/web-search/tavily-live-search"
        );

        if (isTavilyEnabled()) {
          const primaryTopic = detectedTopics.find((t) => t.subcategory) || detectedTopics[0];
          const tavilyResult = await fetchTavilyLiveSources({
            userGoal: queryGoalText,
            entityTerms: entity_terms || [],
            topicCategory: primaryTopic.category,
            topicSubcategory: primaryTopic.subcategory,
            callerTag: "signal_scout_basics",
          });

          if (tavilyResult.candidates.length > 0) {
            return {
              ok: true,
              serviceName: "signal_scout_basics",
              data: {
                ranked_candidates: tavilyResult.candidates,
                top_candidates: tavilyResult.candidates.slice(0, 3).map((r) => r.feed_item_id),
                quick_relevance_notes: tavilyResult.candidates.slice(0, 5).map((r) => r.reason),
                safe_signal_summary: `[basic] RSSHub returned 0 ${primaryTopic.category} sources. Tavily web search returned ${tavilyResult.candidates.length} link(s).`,
                retrieval_mode: "rsshub_empty_tavily_live",
                source_strategy: "tavily_links_only_after_rsshub_empty",
                topic_routes_count: topicResult.diagnostics.topic_routes_count,
                topic_candidates_count: topicResult.candidates.length,
                live_diagnostics: diagnostics,
              },
              safeSummary: `[basic] RSSHub returned 0 sources. Tavily found ${tavilyResult.candidates.length} link(s).`,
              settled: false,
              error: null,
            };
          }
        }
      } catch (tavilyErr: unknown) {
        // Tavily failure must not fail the run — log and continue
        console.warn("[signal_scout_basics] Tavily fallback failed", {
          error: tavilyErr instanceof Error ? tavilyErr.message.slice(0, 100) : String(tavilyErr).slice(0, 100),
        });
      }
    }
  }

  // ── Step 3: No live results — return empty with diagnostics (NO DB fallback) ──
  const topicRoutesCount = topicResult.diagnostics.topic_routes_count;
  const topicCandidatesCount = topicResult.candidates.length;
  const noSourceReason = topicRoutesCount > 0 && topicCandidatesCount === 0
    ? `Topic routes detected (${topicRoutesCount}) but no items passed acceptance gate.`
    : topicRoutesCount === 0
      ? "No topic routes detected and no live search results."
      : "No matching live RSSHub sources found.";

  return {
    ok: true,
    serviceName: "signal_scout_basics",
    data: {
      ranked_candidates: [],
      top_candidates: [],
      quick_relevance_notes: [noSourceReason],
      safe_signal_summary: "[basic] No live RSSHub source matched this query.",
      retrieval_mode: "rsshub_live_empty",
      live_diagnostics: diagnostics,
    },
    safeSummary: "[basic] No live RSSHub source matched this query.",
    settled: false,
    error: null,
  };
};
