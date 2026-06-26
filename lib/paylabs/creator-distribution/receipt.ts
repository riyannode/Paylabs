/**
 * Creator Distribution Receipt Builder
 *
 * Builds safe receipt summaries for creator payouts.
 * No raw signatures, no raw Gateway responses, no secrets.
 */

import type {
  CreatorSplitPlan,
  CreatorPayoutResult,
  AdvancedEvidenceEvaluatorOutput,
  CreatorPayoutTier,
} from "./types";
import { USDC_DECIMALS } from "./split-policy";

// ─── Receipt Summary Builder ──────────────────────────────────

export interface CreatorReceiptSummary {
  execution_fee_usdc: number;
  planned_creator_pool_usdc: number;
  actual_creator_paid_usdc: number;
  planned_creator_payout_count: number;
  actual_creator_payout_count: number;
  pending_creator_reserve_usdc: number;
  bot_share_usdc: number;
  service_share_usdc: number;
  creator_split_policy: string;
  creator_payout_status: string;
  advanced_evaluator_used: boolean;
  advanced_evaluator_confidence: number | null;
  advanced_evaluator_rationale: string | null;
  why_two_sources_needed: string | null;
  creator_payout_results_safe: Array<{
    feed_item_id: string;
    source_url: string;
    creator_wallet: string;
    amount_usdc: number;
    status: string;
  }>;
  safe_receipt_summary: string;
}

/**
 * Build a safe creator receipt summary from split plan and results.
 */
export function buildCreatorReceiptSummary(input: {
  routeTier: CreatorPayoutTier;
  executionFeeUsdc: number;
  splitPlan: CreatorSplitPlan;
  payoutResults: CreatorPayoutResult[];
  evaluatorOutput?: AdvancedEvidenceEvaluatorOutput | null;
}): CreatorReceiptSummary {
  const {
    routeTier,
    executionFeeUsdc,
    splitPlan,
    payoutResults,
    evaluatorOutput,
  } = input;

  const plannedPoolUsdc =
    Number(splitPlan.planned_creator_pool_atomic) / 10 ** USDC_DECIMALS;
  const actualPaidAtomic = payoutResults
 .filter((r) => r.status === "paid" || r.status === "gateway_accepted")
 .reduce((sum, r) => sum + BigInt(r.amount_atomic), BigInt(0));
  const actualPaidUsdc = Number(actualPaidAtomic) / 10 ** USDC_DECIMALS;
  const pendingReserveUsdc =
    Number(splitPlan.pending_creator_reserve_atomic) / 10 ** USDC_DECIMALS;
  const botShareUsdc =
    Number(splitPlan.bot_atomic) / 10 ** USDC_DECIMALS;
  const serviceShareUsdc =
    Number(splitPlan.service_atomic) / 10 ** USDC_DECIMALS;

  const paidCount = payoutResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted"
  ).length;

  // Safe receipt summary by tier
  let safeSummary: string;

  if (routeTier === "easy") {
    safeSummary =
      "PayLabs Easy run: basic discovery completed. No creator payout for this tier.";
  } else if (routeTier === "normal") {
    safeSummary =
      `PayLabs Normal run: ${paidCount} verified creator source selected. ` +
      `Creator pool planned ${plannedPoolUsdc.toFixed(6)} USDC, ` +
      `creator paid ${actualPaidUsdc.toFixed(6)} USDC, ` +
      `bot share ${botShareUsdc.toFixed(6)} USDC, ` +
      `service share ${serviceShareUsdc.toFixed(6)} USDC.`;
  } else {
    const evalNote = evaluatorOutput
      ? ` Deep evidence evaluator checked source contribution (confidence: ${(evaluatorOutput.evaluator_confidence * 100).toFixed(0)}%).`
      : "";
    safeSummary =
      `PayLabs Advanced run: ${paidCount}/${splitPlan.payout_limit} verified creator sources selected.${evalNote} ` +
      `Creator pool planned ${plannedPoolUsdc.toFixed(6)} USDC, ` +
      `creators paid ${actualPaidUsdc.toFixed(6)} USDC total, ` +
      `bot share ${botShareUsdc.toFixed(6)} USDC, ` +
      `service share ${serviceShareUsdc.toFixed(6)} USDC.`;
  }

  // Add pending reserve note if applicable
  if (pendingReserveUsdc > 0 && routeTier !== "easy") {
    safeSummary += ` Remaining creator reserve ${pendingReserveUsdc.toFixed(6)} USDC is pending (unclaimed/ineligible source).`;
  }

  return {
    execution_fee_usdc: executionFeeUsdc,
    planned_creator_pool_usdc: plannedPoolUsdc,
    actual_creator_paid_usdc: actualPaidUsdc,
    planned_creator_payout_count: splitPlan.payout_limit,
    actual_creator_payout_count: paidCount,
    pending_creator_reserve_usdc: pendingReserveUsdc,
    bot_share_usdc: botShareUsdc,
    service_share_usdc: serviceShareUsdc,
    creator_split_policy: "85_10_5_atomic_safe",
    creator_payout_status: paidCount > 0 ? "partial_or_complete" : "none",
    advanced_evaluator_used: !!evaluatorOutput,
    advanced_evaluator_confidence: evaluatorOutput?.evaluator_confidence ?? null,
    advanced_evaluator_rationale:
      evaluatorOutput?.user_facing_rationale ?? null,
    why_two_sources_needed: evaluatorOutput?.why_two_sources_needed ?? null,
    creator_payout_results_safe: payoutResults.map((r) => ({
      feed_item_id: r.feed_item_id,
      source_url: r.source_url,
      creator_wallet: r.creator_wallet,
      amount_usdc: r.amount_usdc,
      status: r.status,
    })),
    safe_receipt_summary: safeSummary,
  };
}
