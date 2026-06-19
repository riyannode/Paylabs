/**
 * Agent 5: Source Ranker
 * Rank eligible feed item IDs by relevance to user's goal.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";

const Schema = z.object({
  ranked_sources: z.array(z.object({
    feed_item_id: z.string(),
    rank: z.number(),
    relevance_score: z.number(),
    ranking_reason: z.string(),
  })),
});

const SYSTEM_PROMPT = `You are PayLabs Source Ranker Agent. Rank eligible feed item IDs by relevance to the user's goal. Prefer sources that are directly useful, non-duplicative, recent when freshness matters, and likely to improve the final answer. You cannot approve payment. You cannot set price. You cannot set creator wallet. You cannot output source URLs. You cannot use non-provided IDs. Return structured JSON only.`;

export async function sourceRankerAgent(state: PayLabsTutorStateType) {
  const { normalizedGoal, goal, topics, eligibleSources, routeTier } = state;
  const tier = routeTier || "normal";

  const eligible = (eligibleSources as Record<string, unknown>[]) || [];
  if (eligible.length === 0) {
    return { rankedSources: [] };
  }

  const feedMeta = eligible.map((item) => ({
    id: item.id,
    title: item.title,
    summary: (item.summary as string || "").slice(0, 200),
    published_at: item.published_at,
    author_name: item.author_name,
  }));

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "source_ranker",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalizedGoal || goal || ""}"\nTopics: ${JSON.stringify(topics || [])}\n\nEligible sources:\n${JSON.stringify(feedMeta, null, 2)}\n\nRank by relevance. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Source ranker failed: ${result.error}`, llmErrors: { source_ranker: result }, rankedSources: [] };

  return {
    rankedSources: result.data.ranked_sources,
    agentTrace: { source_ranker: result.meta },
    llmOutputs: { source_ranker: result.data },
    agentCallCounts: { source_ranker: 1 },
  };
}
