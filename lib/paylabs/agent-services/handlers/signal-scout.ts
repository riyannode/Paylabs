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
 * Discovers and ranks feed items by relevance to expanded queries.
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const SignalScoutSchema = z.object({
  ranked_sources: z.array(z.object({
    feed_item_id: z.string(),
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

  // Keyword overlap with queries
  for (const query of expandedQueries) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    for (const word of words) {
      if (title.includes(word)) score += 3;
      if (summary.includes(word)) score += 1;
      if (publisher.includes(word)) score += 1;
    }
  }

  // Entity term match
  for (const entity of entityTerms) {
    const lower = entity.toLowerCase();
    if (title.includes(lower)) score += 5;
    if (summary.includes(lower)) score += 2;
    if (authorName.includes(lower)) score += 2;
  }

  // Recency bonus (prefer newer items)
  const publishedAt = item.published_at ? new Date(item.published_at as string).getTime() : 0;
  if (publishedAt > 0) {
    const ageHours = (Date.now() - publishedAt) / (1000 * 60 * 60);
    if (ageHours < 24) score += 3;
    else if (ageHours < 72) score += 2;
    else if (ageHours < 168) score += 1;
  }

  // Publisher diversity bonus
  if (publisher && publisher.length > 0) score += 1;

  // Negative filter penalty
  for (const nf of negativeFilters) {
    const nfLower = nf.toLowerCase();
    if (title.includes(nfLower) || summary.includes(nfLower) || publisher.includes(nfLower)) {
      score -= 5;
    }
  }

  // Source preference boost
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
    rank: i + 1,
    relevance_score: Math.min(entry.score / maxScore, 1),
    reason: entry.score > 0
      ? `Keyword/entity match (score: ${entry.score})`
      : "Recency fallback",
  }));
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

  // Load discoverable feed items
  const { listActiveFeedItems } = await import("@/lib/ai/tools");
  const allActive = await listActiveFeedItems() as Record<string, unknown>[];

  if (allActive.length === 0) {
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: [],
        top_candidates: [],
        quick_relevance_notes: ["No active feed items found"],
        safe_signal_summary: "No active feed items available for discovery.",
      },
      safeSummary: "No active feed items available for discovery.",
      settled: false,
      error: null,
    };
  }

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("signal_scout")) {
    const ranked = runDeterministicSignalScout(
      allActive,
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
        safe_signal_summary: `Ranked ${ranked.length} items by keyword/entity match + recency. Deterministic scoring.`,
      },
      safeSummary: `Ranked ${ranked.length} items by keyword/entity match + recency. Deterministic scoring.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode — rank only top deterministic candidates (not all active items)
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  // Pre-score all active items, keep top 20 for LLM reranking
  const deterministicCandidates = runDeterministicSignalScout(
    allActive,
    expanded_queries || [],
    entity_terms || [],
    20,
    negative_filters || [],
    source_preferences || []
  );

  // Build safe metadata from deterministic candidates only
  const candidateIds = new Set(deterministicCandidates.map((c) => c.feed_item_id));
  const feedMeta = allActive
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
      allActive,
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
      },
      safeSummary: `Fallback: ${ranked.length} items ranked deterministically (LLM unavailable).`,
      settled: false,
      error: null,
    };
  }

  const llmRanked = result.data.ranked_sources.filter((r) =>
    allActive.some((f) => f.id === r.feed_item_id)
  );

  return {
    ok: true,
    serviceName: "signal_scout",
    data: {
      ranked_candidates: llmRanked.map((r) => ({
        feed_item_id: r.feed_item_id,
        title: String(allActive.find((f) => f.id === r.feed_item_id)?.title || ""),
        publisher: String(allActive.find((f) => f.id === r.feed_item_id)?.publisher || ""),
        rank: r.rank,
        relevance_score: r.relevance_score,
        reason: r.reason,
      })),
      top_candidates: llmRanked.slice(0, 3).map((r) => r.feed_item_id),
      quick_relevance_notes: llmRanked.slice(0, 5).map((r) => r.reason),
      safe_signal_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
