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

// ─── Helper: Extract service output from evaluations ──────────

function getServiceOutput(
  state: SettlementMemoryStateType,
  serviceName: ServiceName,
): Record<string, unknown> | null {
  const evaluation = (state.serviceEvaluations || []).find(
    (e) => e.serviceName === serviceName,
  );

  if (!evaluation?.output || typeof evaluation.output !== "object") {
    return null;
  }

  return evaluation.output as Record<string, unknown>;
}

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

// ─── Node: Process Attribution Result ────────────────────────
// Copies creator_attribution handler output into LangGraph state
// so downstream nodes (evaluator, payout_router) can read it.

async function processAttributionResult(state: SettlementMemoryStateType) {
  const data = getServiceOutput(state, "creator_attribution");

  // Check evaluation status — fail if attribution failed or returned no output
  const attrEval = (state.serviceEvaluations || []).find(
    (e) => e.serviceName === "creator_attribution",
  );
  const attributionFailed =
    !attrEval || attrEval.status === "failed" || !data || data.ok === false;

  if (attributionFailed) {
    return {
      creatorAttributions: [],
      eligibleCreatorItems: [],
      selectedCreatorPayoutItems: [],
      error: "creator_attribution_failed",
      progressSummaries: [
        "Settlement: creator attribution failed or returned no output; payout routing stopped.",
      ],
    };
  }

  const creatorAttributions = Array.isArray(data.creator_attributions)
    ? data.creator_attributions
    : [];

  const eligibleCreatorItems = Array.isArray(data.eligible_creator_items)
    ? data.eligible_creator_items
    : [];

  return {
    creatorAttributions,
    eligibleCreatorItems,
    selectedCreatorPayoutItems: eligibleCreatorItems,
    progressSummaries: [
      `Settlement: attribution resolved ${eligibleCreatorItems.length}/${creatorAttributions.length} eligible creator source(s).`,
    ],
  };
}

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
  const attrEval = evals.find((e: { serviceName: string }) => e.serviceName === "creator_attribution");
  const attrData = attrEval?.output as Record<string, unknown> | undefined;

  // Extract evaluator results (Advanced only)
  const evalEval = evals.find(
    (e: { serviceName: string }) => e.serviceName === "advanced_evidence_evaluator"
  );
  const evalData = evalEval?.output as Record<string, unknown> | undefined;

  // Extract payout router results
  const payoutEval = evals.find(
    (e: { serviceName: string }) => e.serviceName === "creator_payout_router"
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

  // Extract split plan details from payout router output
  const splitPlan = payoutData?.split_plan as Record<string, unknown> | undefined;
  const pendingReserve = payoutData?.pending_creator_reserve as number | undefined;

  const plannedCreatorPoolAtomic = splitPlan?.planned_creator_pool_atomic
    ? String(splitPlan.planned_creator_pool_atomic)
    : null;
  const splitPlanPayoutLimit = splitPlan?.payout_limit as number | undefined;

  // Compute actual paid amounts from results (not split plan)
  const CREATOR_PAYOUT_UNIT_ATOMIC = BigInt(20);
  const paidResults = creatorPayoutResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted"
  );
  const actualCreatorPaidUsdc = paidResults.reduce((sum, r) => sum + r.amount_usdc, 0);
  const actualCreatorPaidAtomic = paidResults.length > 0
    ? paidResults.reduce((sum, r) => sum + BigInt(r.amount_atomic), BigInt(0)).toString()
    : null;

  // Reserve = planned pool - successfully paid slots (includes failed/pending selected payouts)
  const plannedPoolBigInt = plannedCreatorPoolAtomic ? BigInt(plannedCreatorPoolAtomic) : BigInt(0);
  const paidSlotsBigInt = BigInt(paidResults.length) * CREATOR_PAYOUT_UNIT_ATOMIC;
  const pendingCreatorReserveAtomic = String(plannedPoolBigInt - paidSlotsBigInt);

  // Check evaluator status for Advanced tier
  const evaluatorStatus = evalEval?.status as string | undefined;
  const isAdvancedTier = state.routeTier === "advanced";
  const evaluatorRequiredAndFailed = isAdvancedTier && (!evalEval || evaluatorStatus === "failed");

  let summary: string;
  if (state.routeTier === "easy") {
    summary = "Settlement: Easy tier — no creator payout.";
  } else if (state.routeTier === "normal") {
    summary = `Settlement: Normal tier — ${paidCount} creator(s) paid. Reserve: ${pendingReserve ?? 0} USDC.`;
  } else {
    const evalConfidence = evalData?.evaluator_confidence as number | undefined;
    const evaluatorNote = evaluatorRequiredAndFailed
      ? " [WARNING: evaluator failed — Advanced settlement unreliable]"
      : "";
    summary =
      `Settlement: Advanced tier — ${paidCount} creator(s) paid. ` +
      `Evaluator confidence: ${evalConfidence !== undefined ? (evalConfidence * 100).toFixed(0) + "%" : "N/A"}. ` +
      `Reserve: ${pendingReserve ?? 0} USDC.${evaluatorNote}`;
  }

  return {
    creatorPayoutResults: creatorPayoutResults,
    botShareResult: payoutData?.bot_share_result,
    serviceShareResult: payoutData?.service_share_result,
    creatorPayoutSummary: summary,
    // Split plan fields for orchestrator/visibility
    creatorSplitPlan: splitPlan || null,
    plannedCreatorPoolAtomic,
    pendingCreatorReserveAtomic,
    actualCreatorPaidAtomic: actualCreatorPaidAtomic,
    actualCreatorPaidUsdc,
    plannedCreatorPayoutCount: splitPlanPayoutLimit ?? null,
    advancedEvaluatorStatus: isAdvancedTier ? (evaluatorStatus || "not_run") : null,
    evaluatorMemorySummary: evalData?.safe_memory_update
      ? JSON.stringify(evalData.safe_memory_update)
      : undefined,
    advancedEvaluatorOutput: evalData || null,
    progressSummaries: evaluatorRequiredAndFailed
      ? [summary, "Advanced evaluator failed — settlement marked unreliable."]
      : [summary],
    routedItems: creatorPayoutResults
      .filter((r) => r.status === "paid" || r.status === "gateway_accepted")
      .map((r) => ({
        feed_item_id: r.feed_item_id,
        source_url: r.source_url,
        amount_usdc: r.amount_usdc,
        status: "planned" as const,
      })),
    failedItems: creatorPayoutResults
      .filter((r) => r.status === "failed" || r.status === "pending")
      .map((r) => ({
        feed_item_id: r.feed_item_id,
        source_url: r.source_url,
        error: r.error || `creator_payout_${r.status}`,
      })),
  };
}

// ─── Node: Build Summary ──────────────────────────────────────

async function buildSummary(state: SettlementMemoryStateType) {
  const evals = state.serviceEvaluations || [];

  // Check required services succeeded
  const requiredServices: ServiceName[] = ["creator_attribution", "creator_payout_router"];
  const failedRequired = requiredServices.filter((svc) => {
    const eval_ = evals.find((e: { serviceName: string }) => e.serviceName === svc);
    return !eval_ || eval_.status === "failed";
  });

  // For Advanced tier, advanced_evidence_evaluator is also required
  if (state.routeTier === "advanced") {
    const evalEval = evals.find((e: { serviceName: string }) => e.serviceName === "advanced_evidence_evaluator");
    if (!evalEval || evalEval.status === "failed") {
      failedRequired.push("advanced_evidence_evaluator");
    }
  }

  if (failedRequired.length > 0) {
    const errorMsg = `Settlement required services failed: ${failedRequired.join(", ")}`;
    return {
      progressSummaries: [errorMsg],
      error: errorMsg,
    };
  }

  const summary = state.creatorPayoutSummary || "Settlement: no summary available.";
  return {
    progressSummaries: [summary],
  };
}

// ─── Conditional Routing ──────────────────────────────────────

function routeAfterAttribution(state: SettlementMemoryStateType): string {
  // If attribution failed, skip payout router entirely
  if (state.error) {
    return "build_summary";
  }
  if (state.routeTier === "advanced") {
    return "advanced_evidence_evaluator";
  }
  // Normal: skip evaluator, go directly to payout router
  return "creator_payout_router";
}

function routeAfterEvaluator(state: SettlementMemoryStateType): string {
  // If evaluator failed, skip payout router
  const evalEval = (state.serviceEvaluations || []).find(
    (e) => e.serviceName === "advanced_evidence_evaluator",
  );
  if (!evalEval || evalEval.status === "failed") {
    return "build_summary";
  }
  return "creator_payout_router";
}

// ─── Graph Wiring ────────────────────────────────────────────
// Conditional graph: Advanced runs evaluator, Normal skips it

const graph = new StateGraph(SettlementMemoryState)
  .addNode("creator_attribution", creatorAttributionNode)
  .addNode("process_attribution", processAttributionResult)
  .addNode("advanced_evidence_evaluator", advancedEvidenceEvaluatorNode)
  .addNode("creator_payout_router", creatorPayoutRouterNode)
  .addNode("process_result", processResults)
  .addNode("build_summary", buildSummary)
  .addEdge(START, "creator_attribution")
  .addEdge("creator_attribution", "process_attribution")
  .addConditionalEdges("process_attribution", routeAfterAttribution, {
    advanced_evidence_evaluator: "advanced_evidence_evaluator",
    creator_payout_router: "creator_payout_router",
    build_summary: "build_summary",
  })
  .addConditionalEdges("advanced_evidence_evaluator", routeAfterEvaluator, {
    creator_payout_router: "creator_payout_router",
    build_summary: "build_summary",
  })
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
  /** Deterministic split plan from payout router */
  creatorSplitPlan?: Record<string, unknown> | null;
  /** Planned creator pool in atomic units (string) */
  plannedCreatorPoolAtomic?: string | null;
  /** Pending creator reserve in atomic units (string) */
  pendingCreatorReserveAtomic?: string | null;
  /** Actual creator pool paid in atomic units (string) */
  actualCreatorPaidAtomic?: string | null;
  /** Actual creator paid in USDC */
  actualCreatorPaidUsdc?: number | null;
  /** Planned creator payout count from tier limit */
  plannedCreatorPayoutCount?: number | null;
  /** Advanced evaluator status: "completed" | "failed" | "not_run" | null */
  advancedEvaluatorStatus?: string | null;
  /** Bot platform share result from creator_payout_router */
  botShareResult?: import("../../delegated-runtime/types").PlatformShareResult | null;
  /** Service provider share result from creator_payout_router */
  serviceShareResult?: import("../../delegated-runtime/types").PlatformShareResult | null;
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
      advancedEvaluatorOutput: result.advancedEvaluatorOutput || undefined,
      creatorSplitPlan: result.creatorSplitPlan ?? null,
      plannedCreatorPoolAtomic: result.plannedCreatorPoolAtomic ?? null,
      pendingCreatorReserveAtomic: result.pendingCreatorReserveAtomic ?? null,
      actualCreatorPaidAtomic: result.actualCreatorPaidAtomic ?? null,
      actualCreatorPaidUsdc: result.actualCreatorPaidUsdc ?? null,
      plannedCreatorPayoutCount: result.plannedCreatorPayoutCount ?? null,
      advancedEvaluatorStatus: result.advancedEvaluatorStatus ?? null,
      botShareResult: (result.botShareResult as unknown as import("../../delegated-runtime/types").PlatformShareResult) ?? null,
      serviceShareResult: (result.serviceShareResult as unknown as import("../../delegated-runtime/types").PlatformShareResult) ?? null,
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
