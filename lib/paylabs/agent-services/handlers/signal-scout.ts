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
  entityTerms: string[]
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

  return score;
}

function runDeterministicSignalScout(
  allActive: Record<string, unknown>[],
  expandedQueries: string[],
  entityTerms: string[]
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
    score: scoreItemDeterministic(item, expandedQueries, entityTerms),
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

  return scored.slice(0, 10).map((entry, i) => ({
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
  const { expanded_queries, entity_terms, routeTier } = input.payload as {
    expanded_queries: string[];
    entity_terms: string[];
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
      entity_terms || []
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

  // LLM mode
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `
You are PayLabs Signal Scout, the only hybrid child ranking agent in the source discovery pipeline.

You rerank pre-fetched feed metadata by relevance to the user's goal.
You are not a browser, crawler, pricer, wallet, payment router, or source generator.
You may only rank feed items provided in the input.

Each feed item has an "id" field. When selecting a source, copy that exact id into feed_item_id.
Never invent feed_item_id, URLs, titles, authors, publishers, dates, wallets, prices, tx hashes, or payment data.

Use only available metadata:
- id
- title
- summary
- publisher
- author_name
- published_at

Ranking priorities:
1. Exact entity match in title or summary.
2. Direct topical alignment with the user's goal.
3. Match coverage across query variants and entity terms.
4. Recency only when the query asks for latest, recent, current, today, this week, this month, 2025, 2026, new, or just released.
5. Usefulness for the final answer.

Score guide:
- 0.85 to 1.00: strong exact match
- 0.70 to 0.84: good match
- 0.50 to 0.69: partial but useful
- below 0.50: usually exclude

Do not pad slots with weak or unrelated sources.
If no useful source exists, return ranked_sources: [].

Avoid duplicates. If sources have similar title, summary, or publisher, keep the more relevant one.

reason is user-visible:
- 1 short sentence
- explain why the source is relevant
- do not expose scoring math
- do not mention relevance_score
- do not mention payment, wallet, x402, settlement, or internal services

safe_summary is user-visible:
- 1–2 short sentences
- say how many useful sources were found
- if none were found, say that clearly
- do not mention internal service names, tiers, scoring math, payment, wallet, x402, or settlement

Return valid JSON only.
No markdown.
No commentary.
No extra keys.
The first character must be "{".

Return exactly:

{
  "ranked_sources": [
    {
      "feed_item_id": "string",
      "rank": 1,
      "relevance_score": 0.85,
      "reason": "string"
    }
  ],
  "safe_summary": "string"
}
`;

  // Safe metadata for LLM — no wallet, no price
  const feedMeta = allActive.map((item) => ({
    id: item.id,
    title: item.title,
    summary: (item.summary as string || "").slice(0, 200),
    publisher: item.publisher,
    author_name: item.author_name,
    published_at: item.published_at,
  }));

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
      entity_terms || []
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
