/**
 * Agent 8: Budget Optimizer
 * Backend computes price/split. LLM only explains budget efficiency.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getRouteLimits, computeSplit } from "../route-config";

const Schema = z.object({
  budget_assessment: z.string(),
  efficiency_notes: z.array(z.string()),
  risk_notes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Budget Optimizer Agent. Explain whether the selected evidence path fits the user-approved budget and route spend cap. The actual math is computed by backend from DB prices only. You may reason about budget efficiency but cannot invent or modify prices. You cannot set price. You cannot set wallet. You cannot approve payment. You cannot execute payment. Return structured JSON only.`;

export async function budgetOptimizerAgent(state: PayLabsTutorStateType) {
  const { selectedSources, routeTier, budgetUsdc } = state;
  const tier = routeTier || "normal";
  const limits = getRouteLimits(tier);
  const selected = (selectedSources as Record<string, unknown>[]) || [];

  // Backend deterministic computation
  let totalUsdc = 0;
  for (const s of selected) {
    totalUsdc += Number((s as Record<string, unknown>).citation_price_usdc || s.evidence_score ? 0 : 0);
  }
  // Prices come from DB at persist time — here we estimate from selected metadata
  // For now, use route limits as cap reference
  const effectiveCap = Math.min(budgetUsdc || 0, limits.actualSpendCapUsdc);
  const split = computeSplit(effectiveCap);

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "budget_optimizer",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nUser budget: ${budgetUsdc || 0} USDC\nRoute spend cap: ${limits.actualSpendCapUsdc}\nEffective cap: ${effectiveCap}\nSelected sources: ${selected.length}\nMax sources: ${limits.maxSources}\nCreator payout cap: ${limits.creatorPayoutCapUsdc}\nSplit: 85% creator (${split.creator_amount_usdc}), 10% agent (${split.agent_fee_usdc}), 5% treasury (${split.treasury_fee_usdc})\n\nAssess budget efficiency. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Budget optimizer failed: ${result.error}`, llmErrors: { budget_optimizer: result } };

  return {
    estimatedTotalUsdc: effectiveCap,
    estimatedCreatorPayoutUsdc: split.creator_amount_usdc,
    estimatedAgentFeeUsdc: split.agent_fee_usdc,
    estimatedTreasuryFeeUsdc: split.treasury_fee_usdc,
    remainingUsdc: (budgetUsdc || 0) - effectiveCap,
    effectiveSpendCapUsdc: effectiveCap,
    routeLimits: limits,
    agentTrace: { budget_optimizer: result.meta },
    llmOutputs: { budget_optimizer: result.data },
    agentCallCounts: { budget_optimizer: 1 },
  };
}
