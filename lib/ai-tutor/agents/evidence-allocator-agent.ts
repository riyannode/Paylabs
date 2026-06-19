/**
 * Agent 6: Evidence Allocator
 * Select evidence path using stop-limit terminology.
 * selected_sources / excluded_sources / evidence_score / marginal_value_score.
 * No BUY/SKIP/CACHE.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getRouteLimits } from "../route-config";

const Schema = z.object({
  selected_sources: z.array(z.object({
    feed_item_id: z.string(),
    order_index: z.number(),
    evidence_score: z.number(),
    marginal_value_score: z.number(),
    reason: z.string(),
    expected_value: z.string(),
  })),
  excluded_sources: z.array(z.object({
    feed_item_id: z.string(),
    reason: z.string(),
  })),
  allocation_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Evidence Allocator Agent. Build a compact evidence path from ranked eligible sources. Your job is not to buy/skip/cache. Your job is to choose which sources improve the evidence path under stop-limit constraints. Use PayLabs terminology: selected_sources, excluded_sources, evidence_score, marginal_value_score. Do not use BUY, SKIP, or CACHE labels. Do not approve payment. Do not set price. Do not set wallet. Do not invent URLs. Return structured JSON only.`;

export async function evidenceAllocatorAgent(state: PayLabsTutorStateType) {
  const { normalizedGoal, goal, rankedSources, routeTier, budgetUsdc } = state;
  const tier = routeTier || "normal";
  const limits = getRouteLimits(tier);

  const ranked = (rankedSources as Record<string, unknown>[]) || [];
  if (ranked.length === 0) {
    return { selectedSources: [], excludedSources: [], evidenceScore: 0, marginalValueScore: 0 };
  }

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "evidence_allocator",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalizedGoal || goal || ""}"\nBudget: ${budgetUsdc || 0} USDC\nMax sources: ${limits.maxSources}\nMin evidence score: ${limits.minEvidenceScore}\nStop marginal value below: ${limits.stopMarginalValueBelow}\n\nRanked sources:\n${JSON.stringify(ranked, null, 2)}\n\nSelect evidence path. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Evidence allocator failed: ${result.error}`, llmErrors: { evidence_allocator: result }, selectedSources: [], excludedSources: [] };

  const selected = result.data.selected_sources.slice(0, limits.maxSources);
  const avgEvidence = selected.length > 0
    ? selected.reduce((sum, s) => sum + s.evidence_score, 0) / selected.length
    : 0;
  const avgMarginal = selected.length > 0
    ? selected.reduce((sum, s) => sum + s.marginal_value_score, 0) / selected.length
    : 0;

  return {
    selectedSources: selected,
    excludedSources: result.data.excluded_sources,
    evidenceScore: Math.round(avgEvidence * 100) / 100,
    marginalValueScore: Math.round(avgMarginal * 100) / 100,
    agentTrace: { evidence_allocator: result.meta },
    llmOutputs: { evidence_allocator: result.data },
    agentCallCounts: { evidence_allocator: 1 },
  };
}
