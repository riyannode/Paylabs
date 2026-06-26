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
  const sourceUrl = String(item.source_url || item.url || "").toLowerCase();
  const routePath = String(item.route_path || "").toLowerCase();
  const urlPath = (() => { try { return new URL(sourceUrl).pathname.toLowerCase(); } catch { return ""; } })();

  // 1. Exact entity match (strongest signal)
  for (const entity of entityTerms) {
    const lower = entity.toLowerCase();
    if (!lower) continue;
    if (title.includes(lower)) score += 10;
    else if (summary.includes(lower)) score += 4;
    else if (sourceUrl.includes(lower)) score += 8; // URL contains entity
    else if (routePath.includes(lower)) score += 7; // route_path contains entity
    else if (urlPath.includes(lower)) score += 6; // URL path contains entity
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
          errors: [{ route_path: "*", error_class: "live_disabled" }],
          fallback_reason: "PAYLABS_RSSHUB_LIVE_ENABLED is false",
        },
      },
      safeSummary: "[basic] RSSHub live disabled.",
      settled: false,
      error: null,
    };
  }

  const { candidates: liveResults, diagnostics } = await searchRsshubLive(
    expanded_queries || [],
    entity_terms || [],
    negative_filters || [],
    routeTier || "easy"
  );

  // ── Step 2: If live results found, rescore with deterministic keyword match ──
  if (liveResults.length > 0) {
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
