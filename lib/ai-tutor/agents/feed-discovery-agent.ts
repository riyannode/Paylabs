/**
 * Agent 4: Feed Discovery Agent
 * Load DB feed candidates, deterministic monetization filter.
 * LLM reviews candidates and selects eligible IDs.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { listMonetizedFeedItems } from "../tools";

const Schema = z.object({
  candidate_feed_item_ids: z.array(z.string()),
  discovery_notes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Feed Discovery Agent. Your job is to review DB-provided RSSHub feed candidates and identify eligible candidate IDs for the source path. You may only use the feed items provided by the backend. You cannot invent feed_item_id. You cannot invent source URL. You cannot set creator wallet. You cannot set price. You cannot include unverified or unmonetized sources. You cannot execute payments. Return structured JSON only.`;

export async function feedDiscoveryAgent(state: PayLabsTutorStateType) {
  const { normalizedGoal, goal, topics, expandedQueries, routeTier } = state;
  const tier = routeTier || "normal";

  // Load monetized feed items from DB — deterministic filter
  let candidates: Record<string, unknown>[];
  try {
    candidates = await listMonetizedFeedItems() as Record<string, unknown>[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Feed discovery DB read failed: ${msg}`, candidateSources: [], eligibleSources: [] };
  }

  if (candidates.length === 0) {
    return {
      candidateSources: [],
      eligibleSources: [],
      stopReason: "NO_VERIFIED_SOURCE_AVAILABLE",
      stopLimitHit: true,
    };
  }

  // Safe metadata for LLM — no price, no wallet
  const feedMeta = candidates.map((item) => ({
    id: item.id,
    title: item.title,
    summary: (item.summary as string || "").slice(0, 200),
    route_title: (item.rsshub_route as Record<string, unknown> | undefined)?.title,
    published_at: item.published_at,
    author_name: item.author_name,
    publisher: item.publisher,
  }));

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "feed_discovery_agent",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalizedGoal || goal || ""}"\nTopics: ${JSON.stringify(topics || [])}\nExpanded queries: ${JSON.stringify(expandedQueries || [])}\n\nAvailable monetized feed items (JSON):\n${JSON.stringify(feedMeta, null, 2)}\n\nSelect eligible candidate IDs. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Feed discovery failed: ${result.error}`, llmErrors: { feed_discovery: result }, candidateSources: [], eligibleSources: [] };

  // Validate IDs exist in candidates
  const candidateMap = new Map(candidates.map(c => [c.id as string, c]));
  const eligible = result.data.candidate_feed_item_ids
    .filter(id => candidateMap.has(id))
    .map(id => candidateMap.get(id)!);

  return {
    candidateSources: candidates,
    eligibleSources: eligible,
    agentTrace: { feed_discovery: result.meta },
    llmOutputs: { feed_discovery: result.data },
    agentCallCounts: { feed_discovery: 1 },
  };
}
