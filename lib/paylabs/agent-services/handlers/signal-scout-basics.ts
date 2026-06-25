/**
 * Signal Scout Basics Handler
 *
 * Deterministic-only source discovery for EASY tier.
 * No LLM. No reranking. Pure keyword/entity scoring.
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

// ─── Deterministic Scoring ─────────────────────────────────

function scoreItem(
  item: Record<string, unknown>,
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[] = [],
  sourcePreferences: string[] = []
): number {
  let score = 0;
  const title = String(item.title || "").toLowerCase();
  const summary = String(item.summary || "").toLowerCase();
  const publisher = String(item.publisher || "").toLowerCase();
  const authorName = String(item.author_name || "").toLowerCase();
  const domain = String(item.domain || "").toLowerCase();

  // 1. Exact entity match (strongest signal)
  for (const entity of entityTerms) {
    const lower = entity.toLowerCase();
    if (!lower) continue;
    if (title.includes(lower)) score += 10;
    else if (summary.includes(lower)) score += 4;
    else if (authorName.includes(lower)) score += 3;
    else if (domain.includes(lower)) score += 2;
  }

  // 2. Keyword overlap with queries
  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
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

  return score;
}

// ─── Live RSSHub Search ─────────────────────────────────────

type RankedCandidate = {
  feed_item_id: string;
  title: string;
  publisher: string;
  source_kind: string;
  provider: string;
  source_url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  route_path: string | null;
  rsshub_feed_url: string | null;
  docs_url: string | null;
  rank: number;
  relevance_score: number;
  reason: string;
};

async function searchRsshubLive(
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[],
  routeTier: string
): Promise<RankedCandidate[] | null> {
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

    if (!result.ok || result.sources.length === 0) return null;

    return result.sources.map((s) => ({
      feed_item_id: s.feed_item_id,
      title: s.title,
      publisher: s.publisher,
      source_kind: s.source_kind,
      provider: s.provider,
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
  } catch (err: unknown) {
    console.warn("[signal_scout_basics] RSSHub live search failed", {
      error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
    });
    return null;
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

  // ── Step 1: RSSHub live search (deterministic API call) ──
  const liveEnabled = process.env.PAYLABS_RSSHUB_LIVE_ENABLED !== "false";
  const sourceDiscoveryMode = process.env.PAYLABS_SOURCE_DISCOVERY_MODE || "live_then_db";
  const dbFallbackEnabled = process.env.PAYLABS_DB_FALLBACK_ENABLED !== "false";
  const liveOnly = sourceDiscoveryMode === "live_only" || !dbFallbackEnabled;

  let liveResults: RankedCandidate[] | null = null;

  if (liveEnabled) {
    liveResults = await searchRsshubLive(
      expanded_queries || [],
      entity_terms || [],
      negative_filters || [],
      routeTier || "easy"
    );
  }

  // ── Step 2: If live results found, rescore with deterministic keyword match ──
  if (liveResults && liveResults.length > 0) {
    // Rescore with local deterministic scoring (overrides RSSHub relevance)
    const rescored = liveResults
      .map((item) => ({
        ...item,
        local_score: scoreItem(
          item as unknown as Record<string, unknown>,
          expanded_queries || [],
          entity_terms || [],
          negative_filters || [],
          source_preferences || []
        ),
      }))
      .sort((a, b) => b.local_score - a.local_score)
      .map((item, i) => ({
        ...item,
        rank: i + 1,
        relevance_score: item.local_score > 0
          ? Math.min(item.local_score / 20, 1)
          : item.relevance_score,
      }));

    return {
      ok: true,
      serviceName: "signal_scout_basics",
      data: {
        ranked_candidates: rescored,
        top_candidates: rescored.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: rescored.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `[basic] Live RSSHub: ${rescored.length} source(s) found, rescored by keyword match.`,
        retrieval_mode: "rsshub_live",
      },
      safeSummary: `[basic] Live RSSHub: ${rescored.length} source(s) found.`,
      settled: false,
      error: null,
    };
  }

  // ── Step 2b: Live-only mode — no DB fallback ──
  if (liveOnly) {
    return {
      ok: true,
      serviceName: "signal_scout_basics",
      data: {
        ranked_candidates: [],
        top_candidates: [],
        quick_relevance_notes: ["No matching live RSSHub sources found."],
        safe_signal_summary: "[basic] No live RSSHub source matched this query.",
        retrieval_mode: "rsshub_live_empty",
      },
      safeSummary: "[basic] No live RSSHub source matched this query.",
      settled: false,
      error: null,
    };
  }

  // ── Step 3: DB fallback (live_then_db mode only) ──
  try {
    const { listActiveFeedItems } = await import("@/lib/ai/tools");
    const allActive = (await listActiveFeedItems()) as Record<string, unknown>[];

    if (!allActive || allActive.length === 0) {
      return {
        ok: true,
        serviceName: "signal_scout_basics",
        data: {
          ranked_candidates: [],
          top_candidates: [],
          quick_relevance_notes: ["No feed items in database."],
          safe_signal_summary: "[basic] No feed items available.",
          retrieval_mode: "db_fallback",
        },
        safeSummary: "[basic] No feed items available.",
        settled: false,
        error: null,
      };
    }

    // Deterministic keyword scoring on DB items
    const scored = allActive.map((item) => ({
      item,
      score: scoreItem(
        item,
        expanded_queries || [],
        entity_terms || [],
        negative_filters || [],
        source_preferences || []
      ),
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = new Date(String(a.item.published_at || 0)).getTime();
      const bTime = new Date(String(b.item.published_at || 0)).getTime();
      return bTime - aTime;
    });

    const maxScore = Math.max(scored[0]?.score || 1, 1);

    const ranked: RankedCandidate[] = scored.slice(0, 10).map((entry, i) => {
      const canonicalUrl = String(entry.item.canonical_url || "");
      let domain: string | null = entry.item.domain ? String(entry.item.domain) : null;
      if (!domain && canonicalUrl) {
        try { domain = new URL(canonicalUrl).hostname; } catch { domain = null; }
      }
      return {
        feed_item_id: String(entry.item.id || ""),
        title: String(entry.item.title || ""),
        publisher: String(entry.item.publisher || ""),
        source_kind: "db_feed_item",
        provider: "supabase",
        source_url: canonicalUrl,
        domain,
        summary: String(entry.item.summary || "").slice(0, 300),
        author: String(entry.item.author_name || ""),
        published_at: entry.item.published_at ? String(entry.item.published_at) : null,
        route_path: entry.item.route_path ? String(entry.item.route_path) : null,
        rsshub_feed_url: null,
        docs_url: null,
        rank: i + 1,
        relevance_score: Math.min(entry.score / maxScore, 1),
        reason: entry.score > 0
          ? `[basic] Keyword match (score: ${entry.score})`
          : "[basic] Recency fallback",
      };
    });

    return {
      ok: true,
      serviceName: "signal_scout_basics",
      data: {
        ranked_candidates: ranked,
        top_candidates: ranked.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: ranked.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `[basic] DB fallback: ${ranked.length} items ranked by keyword match.`,
        retrieval_mode: "db_fallback",
      },
      safeSummary: `[basic] DB fallback: ${ranked.length} items ranked.`,
      settled: false,
      error: null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    console.error("[signal_scout_basics] handler error", { error: msg });
    throw new Error(`signal_scout_basics failed: ${msg}`);
  }
};
