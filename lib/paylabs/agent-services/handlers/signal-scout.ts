/**
 * Signal Scout Handler
 *
 * Reuses: source_ranker (feed discovery + ranking)
 * Macro-node: discovery_planner
 * Requires LLM: yes
 *
 * Discovers and ranks feed items by relevance to expanded queries.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const SignalScoutSchema = z.object({
  ranked_sources: z.array(z.object({
    feed_item_id: z.string(),
    rank: z.number(),
    relevance_score: z.number(),
    reason: z.string(),
  })),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Signal Scout. Rank the provided feed items by relevance to the user's queries. Select the most useful items for the user's research need. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

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
    // Fallback: recency order
    const fallback = allActive.slice(0, 10).map((item, i) => ({
      feed_item_id: item.id as string,
      title: String(item.title || ""),
      publisher: String(item.publisher || ""),
      rank: i + 1,
      relevance_score: 0,
    }));
    return {
      ok: true,
      serviceName: "signal_scout",
      data: {
        ranked_candidates: fallback,
        top_candidates: fallback.slice(0, 3).map((f) => f.feed_item_id),
        quick_relevance_notes: ["LLM ranking unavailable, using recency order"],
        safe_signal_summary: `Fallback: ${fallback.length} recent items (LLM ranking unavailable).`,
      },
      safeSummary: `Fallback: ${fallback.length} recent items (LLM ranking unavailable).`,
      settled: false,
      error: null,
    };
  }

  const ranked = result.data.ranked_sources.filter((r) =>
    allActive.some((f) => f.id === r.feed_item_id)
  );

  return {
    ok: true,
    serviceName: "signal_scout",
    data: {
      ranked_candidates: ranked.map((r) => ({
        feed_item_id: r.feed_item_id,
        title: String(allActive.find((f) => f.id === r.feed_item_id)?.title || ""),
        publisher: String(allActive.find((f) => f.id === r.feed_item_id)?.publisher || ""),
        rank: r.rank,
        relevance_score: r.relevance_score,
      })),
      top_candidates: ranked.slice(0, 3).map((r) => r.feed_item_id),
      quick_relevance_notes: ranked.slice(0, 5).map((r) => r.reason),
      safe_signal_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
