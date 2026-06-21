/**
 * Payment Decider Handler
 *
 * New deterministic aggregator — no reused agents.
 * Macro-node: payment_decision
 * Requires LLM: no
 *
 * Deterministic approval rule:
 *   approve only if:
 *   - final_score >= threshold (0.5)
 *   - risk_score <= threshold (0.7)
 *   - item price <= max_allowed_price
 *   - total estimated spend <= remaining budget
 *
 * No LLM. Pure deterministic logic.
 */

import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";

// ─── Thresholds ──────────────────────────────────────────────
const MIN_FINAL_SCORE = 0.5;
const MAX_RISK_SCORE = 0.7;

export const paymentDeciderHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { evaluations, total_budget_usdc, spent_usdc } = input.payload as {
    evaluations: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      quality_score: number;
      risk_score: number;
      roi_score: number;
      estimated_value: number;
      max_allowed_price: number;
      creator_wallet: string | null;
    }>;
    total_budget_usdc: number;
    spent_usdc: number;
  };

  const remainingBudget = total_budget_usdc - spent_usdc;
  let runningSpend = 0;

  const approvedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }> = [];

  const skippedItems: Array<{
    feed_item_id: string;
    source_url: string;
    skip_reason: string;
  }> = [];

  const paymentPlan: Array<{
    feed_item_id: string;
    source_url: string;
    amount_usdc: number;
    creator_wallet: string | null;
  }> = [];

  // Sort by roi_score descending — best candidates first
  const sorted = [...evaluations].sort((a, b) => b.roi_score - a.roi_score);

  for (const item of sorted) {
    // Compute final_score: weighted average of quality, roi, and inverse risk
    const finalScore =
      item.quality_score * 0.4 + item.roi_score * 0.4 + (1 - item.risk_score) * 0.2;

    // Check approval conditions
    if (finalScore < MIN_FINAL_SCORE) {
      skippedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        skip_reason: `Final score ${finalScore.toFixed(2)} below threshold ${MIN_FINAL_SCORE}`,
      });
      continue;
    }

    if (item.risk_score > MAX_RISK_SCORE) {
      skippedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        skip_reason: `Risk score ${item.risk_score.toFixed(2)} above threshold ${MAX_RISK_SCORE}`,
      });
      continue;
    }

    // Price cap: min of estimated_value and max_allowed_price
    const cappedPrice = Math.min(item.estimated_value, item.max_allowed_price);

    if (cappedPrice <= 0) {
      skippedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        skip_reason: "Zero or negative price",
      });
      continue;
    }

    // Budget check
    if (runningSpend + cappedPrice > remainingBudget) {
      skippedItems.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        skip_reason: `Would exceed remaining budget (${remainingBudget.toFixed(6)} USDC)`,
      });
      continue;
    }

    // Approve
    runningSpend += cappedPrice;
    approvedItems.push({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      source_title: item.source_title,
      approved_price_usdc: cappedPrice,
      final_score: finalScore,
      risk_score: item.risk_score,
      creator_wallet: item.creator_wallet,
    });
    paymentPlan.push({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      amount_usdc: cappedPrice,
      creator_wallet: item.creator_wallet,
    });
  }

  const totalSpend = approvedItems.reduce((sum, i) => sum + i.approved_price_usdc, 0);
  const avgScore =
    approvedItems.length > 0
      ? approvedItems.reduce((sum, i) => sum + i.final_score, 0) / approvedItems.length
      : 0;

  const safeSummary = `Approved ${approvedItems.length}/${evaluations.length} items, total spend: ${totalSpend.toFixed(6)} USDC, remaining budget: ${(remainingBudget - totalSpend).toFixed(6)} USDC.`;

  return {
    ok: true,
    serviceName: "payment_decider",
    data: {
      approved_items: approvedItems,
      skipped_items: skippedItems,
      final_score: avgScore,
      total_estimated_spend: totalSpend,
      payment_plan: paymentPlan,
      safe_decision_summary: safeSummary,
    },
    safeSummary,
    settled: false,
    error: null,
  };
};
