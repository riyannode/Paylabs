/**
 * Agent 8: Budget Optimizer (Deterministic)
 *
 * Fully deterministic — no LLM call.
 * Backend computes price/split from route limits and budget.
 * budget_optimizer must pass immediately.
 * It must not call MiMo.
 * It must not call any LLM.
 * It must not approve or execute payment.
 * It must not expose internal settlement mode to users.
 */
import type { PayLabsTutorStateType } from "../state";
import { getRouteLimits, computeSplit } from "../route-config";

export async function budgetOptimizerAgent(state: PayLabsTutorStateType) {
  const { selectedSources, routeTier, budgetUsdc } = state;
  const tier = routeTier || "normal";
  const limits = getRouteLimits(tier);
  const selected = (selectedSources as Record<string, unknown>[]) || [];

  // Backend deterministic computation
  const effectiveCap = Math.min(budgetUsdc || 0, limits.actualSpendCapUsdc);
  const split = computeSplit(effectiveCap);
  const remainingUsdc = Math.max(0, (budgetUsdc || 0) - effectiveCap);

  return {
    estimatedTotalUsdc: effectiveCap,
    estimatedCreatorPayoutUsdc: split.creator_amount_usdc,
    estimatedAgentFeeUsdc: split.agent_fee_usdc,
    estimatedTreasuryFeeUsdc: split.treasury_fee_usdc,
    remainingUsdc,
    effectiveSpendCapUsdc: effectiveCap,
    routeLimits: limits,
    agentTrace: {
      budget_optimizer: {
        mode: "deterministic_backend",
        agent_name: "budget_optimizer",
        route_tier: tier,
        selected_sources: selected.length,
        route_cap_usdc: limits.actualSpendCapUsdc,
        effective_cap_usdc: effectiveCap,
        remaining_usdc: remainingUsdc,
      },
    },
    llmOutputs: {
      budget_optimizer: {
        budget_assessment: effectiveCap > 0
          ? "Budget fits within the selected route spend cap."
          : "No spendable budget is available for this route.",
        efficiency_notes: [
          "Budget math is computed deterministically by backend route limits.",
          "The effective spend cap is the lower value between user budget and route cap.",
          "Unused budget remains unspent.",
        ],
        risk_notes: [
          "Final source payout depends on verified eligible sources.",
          "This node does not approve payment or execute settlement.",
        ],
      },
    },
    agentCallCounts: { budget_optimizer: 0 },
  };
}
