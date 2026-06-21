/**
 * Payment Decision Macro-Node
 *
 * Phase 2 of the delegated runtime.
 * Services: intent_matcher → source_verifier → value_allocator → trust_verifier → payment_decider
 *
 * This phase:
 * 1. Matches candidates against intent (intent_matcher)
 * 2. Verifies source quality and credibility (source_verifier — batch)
 * 3. Allocates value and computes max allowed price (value_allocator — batch)
 * 4. Verifies trust, provenance, and creator ownership (trust_verifier — batch)
 * 5. Makes deterministic payment approval decisions (payment_decider — batch)
 *
 * All calls go through callDelegatedService() (edge + schema validation).
 * Edge chain: signal_scout → intent_matcher → source_verifier → value_allocator → trust_verifier → payment_decider
 */

import type { OrchestratorRunState } from "../types";
import { callDelegatedService } from "../../agent-services/call-delegated-service";
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

  // ── Step 1: Intent Matcher ──
  // Edge: signal_scout → intent_matcher
  // Evaluates candidate relevance against the normalized goal.
  const matcherResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "signal_scout",
    sellerServiceName: "intent_matcher",
    payload: {
      normalized_goal: state.userGoal,
      candidates: candidates.slice(0, 10).map((c) => ({
        feed_item_id: c.feed_item_id,
        title: c.title,
        publisher: c.publisher,
        rank: c.rank,
      })),
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "intent_matcher",
    macroNode: "payment_decision",
    input: { candidate_count: candidates.length },
    output: matcherResult.data,
    safeSummary: matcherResult.safeSummary,
    status: matcherResult.ok ? "completed" : "failed",
    costUsdc: matcherResult.safeCallMeta.costUsdc,
    startedAt: matcherResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: matcherResult.error,
    settled: matcherResult.settled,
    mode: matcherResult.mode,
  });
  updateBudgetSnapshot(state, "intent_matcher", matcherResult.safeCallMeta.costUsdc, matcherResult.settled);

  if (!matcherResult.ok || !matcherResult.data) {
    return {
      ok: false,
      approvedItems: [],
      skippedItems: [],
      totalEstimatedSpend: 0,
      error: `Intent matcher failed: ${matcherResult.error}`,
    };
  }

  const matcherData = matcherResult.data as {
    approved_for_quality_check: boolean;
    relevance_score: number;
  };

  // If intent matcher rejects candidates, skip remaining evaluation
  if (!matcherData.approved_for_quality_check) {
    addProgressSummary(state, `Payment Decision: intent matcher rejected candidates (relevance: ${matcherData.relevance_score.toFixed(2)}). Skipping quality/value/trust evaluation.`);
    return {
      ok: true,
      approvedItems: [],
      skippedItems: candidates.map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url || "",
        skip_reason: "Intent matcher: candidates not approved for quality check",
      })),
      totalEstimatedSpend: 0,
      error: null,
    };
  }

  // Load feed items for metadata (wallet, price, claim status)
  const { getFeedItemById } = await import("@/lib/ai/tools");

  // Prepare candidate metadata for batch evaluation
  const candidateMeta: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    creator_wallet: string | null;
    claim_status: string;
  }> = [];

  for (const candidate of candidates.slice(0, 10)) {
    const feedItem = (await getFeedItemById(candidate.feed_item_id)) as Record<string, unknown> | null;
    candidateMeta.push({
      feed_item_id: candidate.feed_item_id,
      source_url: String(feedItem?.canonical_url || candidate.source_url || ""),
      source_title: String(feedItem?.title || candidate.title || ""),
      creator_wallet: feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : null,
      claim_status: String(feedItem?.verification_status || "unclaimed"),
    });
  }

  // ── Step 2: Source Verifier (batch) ──
  // Edge: intent_matcher → source_verifier
  const verifyResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "intent_matcher",
    sellerServiceName: "source_verifier",
    payload: {
      candidates: candidateMeta.map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        source_title: c.source_title,
      })),
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "source_verifier",
    macroNode: "payment_decision",
    input: { candidate_count: candidateMeta.length },
    output: verifyResult.data,
    safeSummary: verifyResult.safeSummary,
    status: verifyResult.ok ? "completed" : "failed",
    costUsdc: verifyResult.safeCallMeta.costUsdc,
    startedAt: verifyResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: verifyResult.error,
    settled: verifyResult.settled,
    mode: verifyResult.mode,
  });
  updateBudgetSnapshot(state, "source_verifier", verifyResult.safeCallMeta.costUsdc, verifyResult.settled);

  // Extract quality scores
  const qualityScores = new Map<string, number>();
  if (verifyResult.ok && verifyResult.data) {
    const results = verifyResult.data.results as Array<{ feed_item_id: string; quality_score: number }> | undefined;
    if (results) {
      for (const r of results) {
        qualityScores.set(r.feed_item_id, r.quality_score);
      }
    }
  }

  // ── Step 3: Value Allocator (batch) ──
  // Edge: source_verifier → value_allocator
  const valueResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "source_verifier",
    sellerServiceName: "value_allocator",
    payload: {
      candidates: candidateMeta.map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        source_title: c.source_title,
        quality_score: qualityScores.get(c.feed_item_id) ?? 0,
      })),
      remaining_budget_usdc: state.budgetSnapshot.remainingUsdc,
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "value_allocator",
    macroNode: "payment_decision",
    input: { candidate_count: candidateMeta.length, remaining_budget: state.budgetSnapshot.remainingUsdc },
    output: valueResult.data,
    safeSummary: valueResult.safeSummary,
    status: valueResult.ok ? "completed" : "failed",
    costUsdc: valueResult.safeCallMeta.costUsdc,
    startedAt: valueResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: valueResult.error,
    settled: valueResult.settled,
    mode: valueResult.mode,
  });
  updateBudgetSnapshot(state, "value_allocator", valueResult.safeCallMeta.costUsdc, valueResult.settled);

  // Extract value scores
  const valueScores = new Map<string, { roi: number; estimated_value: number; max_allowed_price: number }>();
  if (valueResult.ok && valueResult.data) {
    const results = valueResult.data.results as Array<{ feed_item_id: string; roi_score: number; estimated_value: number; max_allowed_price: number }> | undefined;
    if (results) {
      for (const r of results) {
        valueScores.set(r.feed_item_id, {
          roi: r.roi_score,
          estimated_value: r.estimated_value,
          max_allowed_price: r.max_allowed_price,
        });
      }
    }
  }

  // ── Step 4: Trust Verifier (batch) ──
  // Edge: value_allocator → trust_verifier
  const trustResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "value_allocator",
    sellerServiceName: "trust_verifier",
    payload: {
      candidates: candidateMeta.map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        creator_wallet: c.creator_wallet,
        claim_status: c.claim_status,
      })),
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "trust_verifier",
    macroNode: "payment_decision",
    input: { candidate_count: candidateMeta.length },
    output: trustResult.data,
    safeSummary: trustResult.safeSummary,
    status: trustResult.ok ? "completed" : "failed",
    costUsdc: trustResult.safeCallMeta.costUsdc,
    startedAt: trustResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: trustResult.error,
    settled: trustResult.settled,
    mode: trustResult.mode,
  });
  updateBudgetSnapshot(state, "trust_verifier", trustResult.safeCallMeta.costUsdc, trustResult.settled);

  // Extract risk scores
  const riskScores = new Map<string, number>();
  if (trustResult.ok && trustResult.data) {
    const results = trustResult.data.results as Array<{ feed_item_id: string; risk_score: number }> | undefined;
    if (results) {
      for (const r of results) {
        riskScores.set(r.feed_item_id, r.risk_score);
      }
    }
  }

  // ── Aggregate evaluations for payment_decider ──
  const evaluations = candidateMeta.map((c) => ({
    feed_item_id: c.feed_item_id,
    source_url: c.source_url,
    source_title: c.source_title,
    quality_score: qualityScores.get(c.feed_item_id) ?? 0,
    risk_score: riskScores.get(c.feed_item_id) ?? 0.5,
    roi_score: valueScores.get(c.feed_item_id)?.roi ?? 0,
    estimated_value: valueScores.get(c.feed_item_id)?.estimated_value ?? 0,
    max_allowed_price: valueScores.get(c.feed_item_id)?.max_allowed_price ?? 0,
    creator_wallet: c.creator_wallet,
  }));

  // ── Step 5: Payment Decider (batch, deterministic) ──
  // Edge: trust_verifier → payment_decider
  const deciderResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "trust_verifier",
    sellerServiceName: "payment_decider",
    payload: {
      evaluations,
      total_budget_usdc: state.budgetSnapshot.totalBudgetUsdc,
      spent_usdc: state.budgetSnapshot.spentUsdc,
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "payment_decider",
    macroNode: "payment_decision",
    input: { evaluation_count: evaluations.length },
    output: deciderResult.data,
    safeSummary: deciderResult.safeSummary,
    status: deciderResult.ok ? "completed" : "failed",
    costUsdc: deciderResult.safeCallMeta.costUsdc,
    startedAt: deciderResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: deciderResult.error,
    settled: deciderResult.settled,
    mode: deciderResult.mode,
  });
  updateBudgetSnapshot(state, "payment_decider", deciderResult.safeCallMeta.costUsdc, deciderResult.settled);

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

  const summary = `Payment Decision: intent_matcher(${matcherData.relevance_score.toFixed(2)}) → source_verifier → value_allocator → trust_verifier → payment_decider. ${deciderData.approved_items.length}/${evaluations.length} approved, total: ${deciderData.total_estimated_spend.toFixed(6)} USDC. 5 service calls.`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    approvedItems: deciderData.approved_items,
    skippedItems: deciderData.skipped_items,
    totalEstimatedSpend: deciderData.total_estimated_spend,
    error: null,
  };
}
