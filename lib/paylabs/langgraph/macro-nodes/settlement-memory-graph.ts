/**
 * Settlement Memory LangGraph — Creator Distribution V1
 *
 * Phase 3 of the delegated runtime.
 *
 * Graph shapes by tier:
 *   Easy:     settlement_memory should NOT run (fail closed)
 *   Normal:   START → creator_attribution → creator_payout_router → process_result → build_summary → END
 *   Advanced: START → creator_attribution → advanced_evidence_evaluator → creator_payout_router → process_result → build_summary → END
 *
 * Rules:
 * - LangGraph = internal execution orchestration ONLY
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Service nodes call callDelegatedService()
 * - Creator attribution is deterministic (no LLM)
 * - Advanced evaluator uses LLM + memory (evidence only, no payment authority)
 * - Creator payout router uses deterministic split policy
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { SettlementMemoryState, type SettlementMemoryStateType } from "../shared/state";
import { createServiceNode } from "../services/service-node";
import type { ServiceName } from "../../agent-services/types";
import type { BudgetSnapshot } from "../../delegated-runtime/types";

// ─── Node: Creator Attribution ────────────────────────────────
// Deterministic — no LLM, no payment. Validates wallets and claim status.

const creatorAttributionNode = createServiceNode(
  "creator_attribution",
  "settlement_memory",
  (state) => ({
    approved_items: state.approvedItems || [],
    routeTier: state.routeTier,
  }),
  {
    paymentLayer: "macro_to_child",
    paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback",
    required: true,
    skipIfNotSelected: false,
  }
);

// ─── Node: Advanced Evidence Evaluator ────────────────────────
// Deep Agent + memory. Runs only for Advanced tier.

const advancedEvidenceEvaluatorNode = createServiceNode(
  "advanced_evidence_evaluator",
  "settlement_memory",
  (state) => ({
    user_goal: state.userGoal,
    selected_creator_items: state.selectedCreatorPayoutItems || [],
    approved_items: state.approvedItems || [],
    creator_attributions: state.creatorAttributions || [],
    routeTier: "advanced",
  }),
  {
    paymentLayer: "macro_to_child",
    paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback",
    required: false,
    skipIfNotSelected: true,
  }
);

// ─── Node: Creator Payout Router ──────────────────────────────
// Deterministic split + real payouts through server-side transport.

const creatorPayoutRouterNode = createServiceNode(
  "creator_payout_router",
  "settlement_memory",
  (state) => ({
    creator_attributions: state.creatorAttributions || [],
    selected_creator_items: state.selectedCreatorPayoutItems || [],
    advanced_evaluator_output: state.advancedEvaluatorOutput || null,
    routeTier: state.routeTier,
  }),
  {
    paymentLayer: "macro_to_child",
    paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback",
    required: true,
    skipIfNotSelected: false,
  }
);

// ─── Node: Process Results ────────────────────────────────────

async function processResults(state: SettlementMemoryStateType) {
  const evals = state.serviceEvaluations || [];

  // Extract creator attribution results
  const attrEval = evals.find((e) => e.serviceName === "creator_attribution");
  const attrData = attrEval?.output as Record<string, unknown> | undefined;

  // Extract evaluator results (Advanced only)
  const evalEval = evals.find(
    (e) => e.serviceName === "advanced_evidence_evaluator"
  );
  const evalData = evalEval?.output as Record<string, unknown> | undefined;

  // Extract payout router results
  const payoutEval = evals.find(
    (e) => e.serviceName === "creator_payout_router"
  );
  const payoutData = payoutEval?.output as Record<string, unknown> | undefined;

  // Build creator payout summary
  const creatorPayoutResults = (payoutData?.creator_payout_results || []) as Array<{
    feed_item_id: string;
    source_url: string;
    creator_wallet: string;
    amount_atomic: string;
    amount_usdc: number;
    status: string;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  }>;

  const paidCount = creatorPayoutResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted"
  ).length;

  const splitPlan = payoutData?.split_plan as Record<string, unknown> | undefined;
  const pendingReserve = payoutData?.pending_creator_reserve as number | undefined;

  let summary: string;
  if (state.routeTier === "easy") {
    summary = "Settlement: Easy tier — no creator payout.";
  } else if (state.routeTier === "normal") {
    summary = `Settlement: Normal tier — ${paidCount} creator(s) paid. Reserve: ${pendingReserve ?? 0} USDC.`;
  } else {
    const evalConfidence = evalData?.evaluator_confidence as number | undefined;
    summary =
      `Settlement: Advanced tier — ${paidCount} creator(s) paid. ` +
      `Evaluator confidence: ${evalConfidence !== undefined ? (evalConfidence * 100).toFixed(0) + "%" : "N/A"}. ` +
      `Reserve: ${pendingReserve ?? 0} USDC.`;
  }

  return {
    creatorPayoutResults: creatorPayoutResults,
    botShareResult: payoutData?.bot_share_result,
    serviceShareResult: payoutData?.service_share_result,
    creatorPayoutSummary: summary,
    pendingCreatorReserveAtomic: splitPlan?.pending_creator_reserve_atomic,
    actualCreatorPaidAtomic: splitPlan?.actual_creator_pool_atomic,
    actualCreatorPaidUsdc: creatorPayoutResults
      .filter((r) => r.status === "paid" || r.status === "gateway_accepted")
      .reduce((sum, r) => sum + r.amount_usdc, 0),
    evaluatorMemorySummary: evalData?.safe_memory_update
      ? JSON.stringify(evalData.safe_memory_update)
      : undefined,
    progressSummaries: [summary],
    routedItems: creatorPayoutResults.map((r) => ({
      feed_item_id: r.feed_item_id,
      source_url: r.source_url,
      amount_usdc: r.amount_usdc,
      status: r.status === "paid" || r.status === "gateway_accepted" ? "planned" as const : "planned" as const,
    })),
    failedItems: creatorPayoutResults
      .filter((r) => r.status === "failed")
      .map((r) => ({
        feed_item_id: r.feed_item_id,
        source_url: r.source_url,
        error: r.error || "payout_failed",
      })),
  };
}

// ─── Node: Build Summary ──────────────────────────────────────

async function buildSummary(state: SettlementMemoryStateType) {
  const summary = state.creatorPayoutSummary || "Settlement: no summary available.";
  return {
    progressSummaries: [summary],
  };
}

// ─── Conditional Routing ──────────────────────────────────────

function routeAfterAttribution(state: SettlementMemoryStateType): string {
  if (state.routeTier === "advanced") {
    return "advanced_evidence_evaluator";
  }
  // Normal: skip evaluator, go directly to payout router
  return "creator_payout_router";
}

// ─── Graph Wiring ────────────────────────────────────────────
// Conditional graph: Advanced runs evaluator, Normal skips it

const graph = new StateGraph(SettlementMemoryState)
  .addNode("creator_attribution", creatorAttributionNode)
  .addNode("advanced_evidence_evaluator", advancedEvidenceEvaluatorNode)
  .addNode("creator_payout_router", creatorPayoutRouterNode)
  .addNode("process_result", processResults)
  .addNode("build_summary", buildSummary)
  .addEdge(START, "creator_attribution")
  .addConditionalEdges("creator_attribution", routeAfterAttribution, {
    advanced_evidence_evaluator: "advanced_evidence_evaluator",
    creator_payout_router: "creator_payout_router",
  })
  .addEdge("advanced_evidence_evaluator", "creator_payout_router")
  .addEdge("creator_payout_router", "process_result")
  .addEdge("process_result", "build_summary")
  .addEdge("build_summary", END)
  .compile();

// ─── Public API ──────────────────────────────────────────────

export interface RunSettlementMemoryGraphInput {
  discoveryRunId: string;
  userGoal: string;
  routeTier: "easy" | "normal" | "advanced";
  userBudgetUsdc: number;
  approvedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>;
  selectedServices?: ServiceName[];
  parentWalletId?: string;
}

export interface RunSettlementMemoryGraphOutput {
  ok: boolean;
  routedItems: Array<{
    feed_item_id: string;
    source_url: string;
    amount_usdc: number;
    status: "planned";
  }>;
  failedItems: Array<{
    feed_item_id: string;
    source_url: string;
    error: string;
  }>;
  advancedSummary: string;
  serviceEvaluations: SettlementMemoryStateType["serviceEvaluations"];
  paymentEdges: SettlementMemoryStateType["paymentEdges"];
  progressSummaries: string[];
  creatorPayoutSummary?: string;
  creatorPayoutResults?: Array<{
    feed_item_id: string;
    source_url: string;
    creator_wallet: string;
    amount_atomic: string;
    amount_usdc: number;
    status: string;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  }>;
  advancedEvaluatorOutput?: Record<string, unknown>;
  error: string | null;
}

/**
 * Run the Settlement Memory graph with creator distribution V1.
 *
 * Easy: fail closed (should not be called)
 * Normal: creator_attribution → creator_payout_router
 * Advanced: creator_attribution → advanced_evidence_evaluator → creator_payout_router
 */
export async function runSettlementMemoryGraph(
  input: RunSettlementMemoryGraphInput
): Promise<RunSettlementMemoryGraphOutput> {
  // Fail closed for Easy tier
  if (input.routeTier === "easy") {
    return {
      ok: false,
      routedItems: [],
      failedItems: [],
      advancedSummary: "Settlement failed: Easy tier must not run settlement_memory.",
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: ["Settlement failed: Easy tier must not run settlement_memory."],
      error: "settlement_memory_easy_tier_violation",
    };
  }

  const initialBudget: BudgetSnapshot = {
    totalBudgetUsdc: input.userBudgetUsdc,
    spentUsdc: 0,
    remainingUsdc: input.userBudgetUsdc,
    serviceSpend: {} as Record<ServiceName, number>,
    settledServiceFeesUsdc: 0,
    estimatedServiceFeesUsdc: 0,
  };

  try {
    const result = await graph.invoke({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      approvedItems: input.approvedItems,
      selectedServices: input.selectedServices || [],
      parentWalletId: input.parentWalletId,
      budgetSnapshot: initialBudget,
      // Initialize
      creatorAttributions: [],
      eligibleCreatorItems: [],
      selectedCreatorPayoutItems: [],
      creatorPayoutResults: [],
      routedItems: [],
      failedItems: [],
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [],
    });

    return {
      ok: !result.error,
      routedItems: result.routedItems || [],
      failedItems: result.failedItems || [],
      advancedSummary: result.creatorPayoutSummary || "Settlement completed.",
      serviceEvaluations: result.serviceEvaluations || [],
      paymentEdges: result.paymentEdges || [],
      progressSummaries: result.progressSummaries || [],
      creatorPayoutSummary: result.creatorPayoutSummary,
      creatorPayoutResults: result.creatorPayoutResults,
      advancedEvaluatorOutput: result.advancedEvaluatorOutput,
      error: result.error || null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      routedItems: [],
      failedItems: [],
      advancedSummary: `Settlement failed: ${msg}`,
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [`Settlement graph error: ${msg}`],
      error: msg,
    };
  }
}
