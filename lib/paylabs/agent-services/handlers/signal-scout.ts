/**
 * Signal Scout Handler
 *
 * Reuses: source_ranker (feed discovery + ranking)
 * Macro-node: discovery_planner
 * Execution modes:
 *   - deterministic (default): DB/feed ranking using recency, metadata, keywords
 *   - llm: LLM-powered relevance ranking
 *   - hybrid: deterministic ranking + LLM relevance explanation
 *
 * V3 CHANGE: Live-first discovery.
 * 1. RSSHub live search (if enabled)
 * 2. DB fallback (if live empty/failed)
 * 3. Improved scoring: exact entity > title > domain > summary > recency
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const SignalScoutSchema = z.object({
  ranked_sources: z.array(z.object({
    feed_item_id: z.string(),
    source_kind: z.string().optional(),
    provider: z.string().optional(),
    title: z.string(),
    publisher: z.string(),
    source_url: z.string().optional(),
    domain: z.string().nullable().optional(),
    summary: z.string().optional(),
    author: z.string().optional(),
    published_at: z.string().nullable().optional(),
    route_path: z.string().optional(),
    rsshub_feed_url: z.string().nullable().optional(),
    docs_url: z.string().nullable().optional(),
    rank: z.number(),
    relevance_score: z.number(),
    reason: z.string(),
  })),
  safe_summary: z.string(),
});

// ─── Deterministic Signal Scoring ───────────────────────────

function scoreItemDeterministic(
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

  // 3. Recency bonus (prefer newer items, but only if already relevant)
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

function runDeterministicSignalScout(
  allActive: Record<string, unknown>[],
  expandedQueries: string[],
  entityTerms: string[],
  limit = 10,
  negativeFilters: string[] = [],
  sourcePreferences: string[] = []
): Array<{
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
}> {
  // Score each item
  const scored = allActive.map((item) => ({
    item,
    score: scoreItemDeterministic(item, expandedQueries, entityTerms, negativeFilters, sourcePreferences),
  }));

  // Sort by score descending, then by recency
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = new Date(String(a.item.published_at || 0)).getTime();
    const bTime = new Date(String(b.item.published_at || 0)).getTime();
    return bTime - aTime;
  });

  // Normalize scores to 0-1 range
  const maxScore = Math.max(scored[0]?.score || 1, 1);

  return scored.slice(0, limit).map((entry, i) => ({
    feed_item_id: String(entry.item.id || ""),
    title: String(entry.item.title || ""),
    publisher: String(entry.item.publisher || ""),
    source_kind: "db_feed_item",
    provider: "supabase",
    source_url: String(entry.item.canonical_url || ""),
    domain: entry.item.domain ? String(entry.item.domain) : null,
    summary: String(entry.item.summary || "").slice(0, 300),
    author: String(entry.item.author_name || ""),
    published_at: entry.item.published_at ? String(entry.item.published_at) : null,
    route_path: entry.item.route_path ? String(entry.item.route_path) : null,
    rsshub_feed_url: null,
    docs_url: null,
    rank: i + 1,
    relevance_score: Math.min(entry.score / maxScore, 1),
    reason: entry.score > 0
      ? `Keyword/entity match (score: ${entry.score})`
      : "Recency fallback",
  }));
}

// ─── Live RSSHub Search ─────────────────────────────────────

async function runLiveSearch(
  expandedQueries: string[],
  entityTerms: string[],
  negativeFilters: string[],
  routeTier: string
): Promise<Array<{
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
}> | null> {
  try {
    const { liveSearchRsshub } = await import("@/lib/rsshub/rsshub-live-search");

    // Finding 5: Build resolver query from ALL variants, not just the first one
    // Route resolver needs to see all query variants to extract entities like openai/codex
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
    console.warn("[signal_scout] live RSSHub search failed", {
      error: err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100),
    });
    return null;
  }
}

// ─── Handler ────────────────────────────────────────────────

export const signalScoutHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { expanded_queries, entity_terms, negative_filters, source_preferences, routeTier } = input.payload as {
    expanded_queries: string[];
    entity_terms: string[];
    negative_filters?: string[];
    source_preferences?: string[];
    routeTier?: DelegatedRouteTier;
  };

  // ── Step 1: Try live RSSHub search first ──
  const liveEnabled = process.env.PAYLABS_RSSHUB_LIVE_ENABLED !== "false";
  const sourceDiscoveryMode = process.env.PAYLABS_SOURCE_DISCOVERY_MODE || "live_then_db";
  const dbFallbackEnabled = process.env.PAYLABS_DB_FALLBACK_ENABLED !== "false";
  const liveOnly = sourceDiscoveryMode === "live_only" || !dbFallbackEnabled;

  let liveResults: Awaited<ReturnType<typeof runLiveSearch>> = null;

  if (liveEnabled) {
    liveResults = await runLiveSearch(
      expanded_queries || [],
      entity_terms || [],
      negative_filters || [],
      routeTier || "easy"
    );
  }

  // ── Step 2: If live search returned results, use them ──
  if (liveResults && liveResults.length > 0) {
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: liveResults,
        top_candidates: liveResults.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: liveResults.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `Live RSSHub: ${liveResults.length} source(s) found from ${liveResults.filter((s) => s.source_kind === "rsshub_live").length} route(s).`,
        retrieval_mode: "rsshub_live",
      },
      safeSummary: `Live RSSHub: ${liveResults.length} source(s) found.`,
      settled: false,
      error: null,
    };
  }

  // ── Step 2b: If live-only mode, do NOT fallback to DB ──
  if (liveOnly) {
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: [],
        top_candidates: [],
        quick_relevance_notes: ["No matching live RSSHub sources found."],
        safe_signal_summary: "No live RSSHub source matched this query.",
        retrieval_mode: "rsshub_live_empty",
      },
      safeSummary: "No live RSSHub source matched this query.",
      settled: false,
      error: null,
    };
  }

  // ── Step 3: Fallback to DB (live_then_db mode only) ──
  const { listActiveFeedItems } = await import("@/lib/ai/tools");
  const dbMaxItems = Number(process.env.PAYLABS_DB_FALLBACK_MAX_ITEMS) || 200;
  const allActiveRaw = await listActiveFeedItems() as Record<string, unknown>[];

  // Finding 6: Derive domain from canonical_url if not present
  for (const item of allActiveRaw) {
    if (!item.domain && item.canonical_url) {
      try {
        item.domain = new URL(String(item.canonical_url)).hostname;
      } catch { /* invalid URL, skip */ }
    }
  }

  // Finding 4: Score ALL items first, then cap output — don't slice before scoring
  // (older exact matches must not be excluded by recency slicing)

  if (allActiveRaw.length === 0) {
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: [],
        top_candidates: [],
        quick_relevance_notes: liveResults === null
          ? ["Live RSSHub unavailable, no active DB feed items"]
          : ["No relevant sources found from RSSHub or database"],
        safe_signal_summary: liveResults === null
          ? "Live RSSHub unavailable. No active feed items in database."
          : "No relevant sources found from RSSHub live or database.",
        retrieval_mode: liveResults === null ? "rsshub_live_empty" : "db_fallback",
      },
      safeSummary: "No active feed items available for discovery.",
      settled: false,
      error: null,
    };
  }

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("signal_scout")) {
    const ranked = runDeterministicSignalScout(
      allActiveRaw,
      expanded_queries || [],
      entity_terms || [],
      10,
      negative_filters || [],
      source_preferences || []
    );
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: ranked,
        top_candidates: ranked.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: ranked.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `DB fallback: ${ranked.length} items ranked by keyword/entity match. Live RSSHub: ${liveResults === null ? "unavailable" : "no results"}.`,
        retrieval_mode: "db_fallback",
      },
      safeSummary: `DB fallback: ${ranked.length} items ranked. Deterministic scoring.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode — rank only top deterministic candidates (not all active items)
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  // Pre-score all active items, keep top 20 for LLM reranking
  const deterministicCandidates = runDeterministicSignalScout(
    allActiveRaw,
    expanded_queries || [],
    entity_terms || [],
    20,
    negative_filters || [],
    source_preferences || []
  );

  // Build safe metadata from deterministic candidates only
  const candidateIds = new Set(deterministicCandidates.map((c) => c.feed_item_id));
  const feedMeta = allActiveRaw
    .filter((item) => candidateIds.has(String(item.id)))
    .map((item) => ({
      id: item.id,
      title: item.title,
      summary: String(item.summary || "").slice(0, 300),
      publisher: item.publisher,
      author_name: item.author_name,
      published_at: item.published_at,
    }));

  const SYSTEM_PROMPT = `You are PayLabs Signal Scout.
Your task is to rerank pre-fetched feed items for source discovery.
You may only use feed items provided in the input. You are not a browser. You are not a crawler. You are not a wallet. You are not a payment router. You are not a pricer.
Never invent:
feed_item_id
title
publisher
URL
author
date
wallet
price
tx hash
payment status
settlement status
Ranking priorities:
exact entity match in title or summary
direct relevance to the query
source usefulness for the user's goal
freshness only if the query asks for latest/current/recent/today/this week/2025/2026/new
avoid duplicates and weak filler sources
Use only the provided candidate feed items. If no useful source exists, return ranked_sources: [].
reason must be 1 short user-safe sentence. Do not mention internal scoring math. Do not mention relevance_score. Do not mention x402, wallets, payment, Gateway, or settlement.
safe_summary must be 1 short sentence.
Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{".`;

  const result = await generateStructuredJson<z.infer<typeof SignalScoutSchema>>({
    agentName: "signal_scout",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Queries: ${JSON.stringify(expanded_queries)}\nEntity terms: ${JSON.stringify(entity_terms)}\n\nAvailable feed items:\n${JSON.stringify(feedMeta, null, 2)}\n\nRank by relevance. Return structured JSON only.`,
    schema: SignalScoutSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic ranking
    const ranked = runDeterministicSignalScout(
      allActiveRaw,
      expanded_queries || [],
      entity_terms || [],
      10,
      negative_filters || [],
      source_preferences || []
    );
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: ranked,
        top_candidates: ranked.slice(0, 3).map((r) => r.feed_item_id),
        quick_relevance_notes: ranked.slice(0, 5).map((r) => r.reason),
        safe_signal_summary: `Fallback: ${ranked.length} items ranked deterministically (LLM unavailable).`,
        retrieval_mode: "db_fallback",
      },
      safeSummary: `Fallback: ${ranked.length} items ranked deterministically (LLM unavailable).`,
      settled: false,
      error: null,
    };
  }

  const llmRanked = result.data.ranked_sources.filter((r) =>
    allActiveRaw.some((f) => f.id === r.feed_item_id)
  );

  return {
    ok: true,
    serviceName: "signal_scout",
    data: {
      ranked_candidates: llmRanked.map((r) => ({
        feed_item_id: r.feed_item_id,
        title: String(allActiveRaw.find((f) => f.id === r.feed_item_id)?.title || ""),
        publisher: String(allActiveRaw.find((f) => f.id === r.feed_item_id)?.publisher || ""),
        source_kind: r.source_kind || "db_feed_item",
        provider: r.provider || "supabase",
        source_url: r.source_url || String((allActiveRaw.find((f) => f.id === r.feed_item_id) as Record<string, unknown>)?.canonical_url || ""),
        domain: r.domain ?? null,
        summary: r.summary || "",
        author: r.author || "",
        published_at: r.published_at ?? null,
        route_path: r.route_path || null,
        rsshub_feed_url: r.rsshub_feed_url ?? null,
        docs_url: r.docs_url ?? null,
        rank: r.rank,
        relevance_score: r.relevance_score,
        reason: r.reason,
      })),
      top_candidates: llmRanked.slice(0, 3).map((r) => r.feed_item_id),
      quick_relevance_notes: llmRanked.slice(0, 5).map((r) => r.reason),
      safe_signal_summary: result.data.safe_summary,
      retrieval_mode: "db_fallback",
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
