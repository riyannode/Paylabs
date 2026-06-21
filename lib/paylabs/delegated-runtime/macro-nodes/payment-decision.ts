/**
 * Payment Decision Macro-Node
 *
 * Phase 2 of the delegated runtime.
 * Services: source_verifier → value_allocator → trust_verifier → payment_decider
 *
 * This phase:
 * 1. Verifies source quality and credibility
 * 2. Allocates value and computes max allowed price
 * 3. Verifies trust, provenance, and creator ownership
 * 4. Makes deterministic payment approval decisions
 */

import type { OrchestratorRunState } from "../types";
import type { ServiceHandlerInput, ServiceName } from "../../agent-services/types";
import { SERVICE_HANDLERS } from "../../agent-services/handlers";
import { addServiceEvaluation, updateBudgetSnapshot, addProgressSummary } from "../state";

// ─── Run Payment Decision ────────────────────────────────────

export async function runPaymentDecision(
  state: OrchestratorRunState,
  candidates: Array<{
    feed_item_id: string;
    source_url?: string;
    title: string;
    publisher: string;
    rank: number;
    relevance_score: number;
  }>
): Promise<{
  ok: boolean;
  approvedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>;
  skippedItems: Array<{
    feed_item_id: string;
    source_url: string;
    skip_reason: string;
  }>;
  totalEstimatedSpend: number;
  error: string | null;
}> {
  if (candidates.length === 0) {
    return {
      ok: true,
      approvedItems: [],
      skippedItems: [],
      totalEstimatedSpend: 0,
      error: null,
    };
  }

  // Load feed items for metadata (wallet, price, claim status)
  const { getFeedItemById } = await import("@/lib/ai/tools");

  // ── Evaluate each candidate through source_verifier → value_allocator → trust_verifier ──
  const evaluations: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    quality_score: number;
    risk_score: number;
    roi_score: number;
    estimated_value: number;
    max_allowed_price: number;
    creator_wallet: string | null;
  }> = [];

  for (const candidate of candidates.slice(0, 10)) {
    const feedItem = await getFeedItemById(candidate.feed_item_id) as Record<string, unknown> | null;
    const sourceUrl = String(feedItem?.canonical_url || candidate.source_url || "");
    const sourceTitle = String(feedItem?.title || candidate.title || "");
    const creatorWallet = feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : null;
    const claimStatus = String(feedItem?.verification_status || "unclaimed");

    // ── Source Verifier ──
    const verifyInput: ServiceHandlerInput = {
      discoveryRunId: state.discoveryRunId,
      serviceName: "source_verifier",
      payload: {
        feed_item_id: candidate.feed_item_id,
        source_url: sourceUrl,
        source_title: sourceTitle,
        routeTier: state.routeTier,
      },
    };

    const verifyResult = await SERVICE_HANDLERS.source_verifier(verifyInput);
    addServiceEvaluation(state, {
      serviceName: "source_verifier",
      macroNode: "payment_decision",
      input: verifyInput.payload,
      output: verifyResult.data,
      safeSummary: verifyResult.safeSummary,
      status: verifyResult.ok ? "completed" : "failed",
      costUsdc: 0.000001,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: verifyResult.error,
    });
    updateBudgetSnapshot(state, "source_verifier", 0.000001);

    const qualityScore = verifyResult.ok && verifyResult.data
      ? (verifyResult.data as { quality_score: number }).quality_score
      : 0;

    // ── Value Allocator ──
    const valueInput: ServiceHandlerInput = {
      discoveryRunId: state.discoveryRunId,
      serviceName: "value_allocator",
      payload: {
        source_url: sourceUrl,
        source_title: sourceTitle,
        quality_score: qualityScore,
        remaining_budget_usdc: state.budgetSnapshot.remainingUsdc,
        routeTier: state.routeTier,
      },
    };

    const valueResult = await SERVICE_HANDLERS.value_allocator(valueInput);
    addServiceEvaluation(state, {
      serviceName: "value_allocator",
      macroNode: "payment_decision",
      input: valueInput.payload,
      output: valueResult.data,
      safeSummary: valueResult.safeSummary,
      status: valueResult.ok ? "completed" : "failed",
      costUsdc: 0.000001,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: valueResult.error,
    });
    updateBudgetSnapshot(state, "value_allocator", 0.000001);

    const valueData = valueResult.data as {
      roi_score: number;
      estimated_value: number;
      max_allowed_price: number;
    } | null;

    // ── Trust Verifier ──
    const trustInput: ServiceHandlerInput = {
      discoveryRunId: state.discoveryRunId,
      serviceName: "trust_verifier",
      payload: {
        feed_item_id: candidate.feed_item_id,
        source_url: sourceUrl,
        creator_wallet: creatorWallet,
        claim_status: claimStatus,
        routeTier: state.routeTier,
      },
    };

    const trustResult = await SERVICE_HANDLERS.trust_verifier(trustInput);
    addServiceEvaluation(state, {
      serviceName: "trust_verifier",
      macroNode: "payment_decision",
      input: trustInput.payload,
      output: trustResult.data,
      safeSummary: trustResult.safeSummary,
      status: trustResult.ok ? "completed" : "failed",
      costUsdc: 0.000001,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: trustResult.error,
    });
    updateBudgetSnapshot(state, "trust_verifier", 0.000001);

    const trustData = trustResult.data as {
      risk_score: number;
    } | null;

    evaluations.push({
      feed_item_id: candidate.feed_item_id,
      source_url: sourceUrl,
      source_title: sourceTitle,
      quality_score: qualityScore,
      risk_score: trustData?.risk_score ?? 0.5,
      roi_score: valueData?.roi_score ?? 0,
      estimated_value: valueData?.estimated_value ?? 0,
      max_allowed_price: valueData?.max_allowed_price ?? 0,
      creator_wallet: creatorWallet,
    });
  }

  // ── Payment Decider (deterministic aggregator) ──
  const deciderInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "payment_decider",
    payload: {
      evaluations,
      total_budget_usdc: state.budgetSnapshot.totalBudgetUsdc,
      spent_usdc: state.budgetSnapshot.spentUsdc,
      routeTier: state.routeTier,
    },
  };

  const deciderResult = await SERVICE_HANDLERS.payment_decider(deciderInput);
  addServiceEvaluation(state, {
    serviceName: "payment_decider",
    macroNode: "payment_decision",
    input: deciderInput.payload,
    output: deciderResult.data,
    safeSummary: deciderResult.safeSummary,
    status: deciderResult.ok ? "completed" : "failed",
    costUsdc: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: deciderResult.error,
  });

  if (!deciderResult.ok || !deciderResult.data) {
    return {
      ok: false,
      approvedItems: [],
      skippedItems: [],
      totalEstimatedSpend: 0,
      error: `Payment decider failed: ${deciderResult.error}`,
    };
  }

  const deciderData = deciderResult.data as {
    approved_items: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      approved_price_usdc: number;
      final_score: number;
      risk_score: number;
      creator_wallet: string | null;
    }>;
    skipped_items: Array<{
      feed_item_id: string;
      source_url: string;
      skip_reason: string;
    }>;
    total_estimated_spend: number;
  };

  const summary = `Payment Decision: ${deciderData.approved_items.length}/${evaluations.length} approved, total spend: ${deciderData.total_estimated_spend.toFixed(6)} USDC.`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    approvedItems: deciderData.approved_items,
    skippedItems: deciderData.skipped_items,
    totalEstimatedSpend: deciderData.total_estimated_spend,
    error: null,
  };
}
