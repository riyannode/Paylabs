/**
 * Settlement Memory LangGraph
 *
 * Phase 3 of the delegated runtime.
 * Services: payment_router (only 1 child → per-child Circle x402)
 *
 * Graph: START → payment_router → process_result → build_summary → END
 *
 * Rules:
 * - LangGraph = internal execution orchestration ONLY
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Service nodes call callDelegatedService()
 * - settlement_memory has only 1 child → per-child Circle x402
 * - Returns routedItems + advanced_summary
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { SettlementMemoryState, type SettlementMemoryStateType } from "../shared/state";
import { createServiceNode } from "../services/service-node";
import type { ServiceName } from "../../agent-services/types";
import type { BudgetSnapshot } from "../../delegated-runtime/types";
import { randomUUID } from "node:crypto";

// ─── Node: Payment Router ───────────────────────────────────
// settlement_memory has only 1 child → per-child Circle x402

const paymentRouterNode = createServiceNode(
  "payment_router",
  "settlement_memory",
  (state) => ({
    approved_items: state.approvedItems || [],
    discovery_run_id: state.discoveryRunId,
    routeTier: state.routeTier,
  }),
  {
    paymentLayer: "macro_to_child",
    paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback",
    required: true,
    skipIfNotSelected: false,
  }
);

// ─── Node: Process Router Result ────────────────────────────

async function processRouterResult(state: SettlementMemoryStateType) {
  const evals = state.serviceEvaluations || [];
  const routerEval = evals.find((e) => e.serviceName === "payment_router");

  if (!routerEval?.output) {
    return {
      routedItems: [] as SettlementMemoryStateType["routedItems"],
      failedItems: [] as SettlementMemoryStateType["failedItems"],
      progressSummaries: ["Settlement: payment_router returned no output"],
    };
  }

  const data = routerEval.output as {
    routed_items?: Array<{
      feed_item_id: string;
      source_url: string;
      amount_usdc: number;
      status: "planned";
    }>;
    failed_items?: Array<{
      feed_item_id: string;
      source_url: string;
      error: string;
    }>;
  };

  return {
    routedItems: data.routed_items || [],
    failedItems: data.failed_items || [],
  };
}

// ─── Node: Build Advanced Summary ───────────────────────────

async function buildAdvancedSummary(state: SettlementMemoryStateType) {
  const routed = state.routedItems?.length || 0;
  const failed = state.failedItems?.length || 0;

  const summary = `Settlement: ${routed} items routed, ${failed} failed. ` +
    `Mode: Circle x402. 1 service executed (per-child fallback).`;

  return {
    progressSummaries: [summary],
  };
}

// ─── Graph Wiring ───────────────────────────────────────────

const graph = new StateGraph(SettlementMemoryState)
  .addNode("payment_router", paymentRouterNode)
  .addNode("process_result", processRouterResult)
  .addNode("build_summary", buildAdvancedSummary)
  .addEdge(START, "payment_router")
  .addEdge("payment_router", "process_result")
  .addEdge("process_result", "build_summary")
  .addEdge("build_summary", END)
  .compile();

// ─── Public API ─────────────────────────────────────────────

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
  error: string | null;
}

/**
 * Run the Settlement Memory graph (replaces plain async runner).
 */
export async function runSettlementMemoryGraph(
  input: RunSettlementMemoryGraphInput
): Promise<RunSettlementMemoryGraphOutput> {
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
      routedItems: [],
      failedItems: [],
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [],
    });

    const routed = result.routedItems?.length || 0;
    const failed = result.failedItems?.length || 0;
    const advancedSummary = `Settlement: ${routed} items routed, ${failed} failed. Mode: Circle x402. 1 service executed (per-child fallback).`;

    return {
      ok: !result.error,
      routedItems: result.routedItems || [],
      failedItems: result.failedItems || [],
      advancedSummary,
      serviceEvaluations: result.serviceEvaluations || [],
      paymentEdges: result.paymentEdges || [],
      progressSummaries: result.progressSummaries || [],
      error: result.error || null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
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
