/**
 * Settlement & Memory Macro-Node
 *
 * Phase 3 of the delegated runtime.
 * Services: payment_router
 *
 * This phase:
 * 1. Routes approved items through payment_router
 * 2. Records payment edges
 * 3. Persists safe evaluation summaries
 *
 * In audit mode (default): marks settled=false, no real payments.
 * In x402 mode: executes real payments via PR #19 infrastructure.
 */

import type { OrchestratorRunState, PaymentEdge } from "../types";
import type { ServiceHandlerInput } from "../../agent-services/types";
import { SERVICE_HANDLERS } from "../../agent-services/handlers";
import { addServiceEvaluation, updateBudgetSnapshot, addProgressSummary } from "../state";
import { randomUUID } from "node:crypto";

// ─── Run Settlement & Memory ─────────────────────────────────

export async function runSettlementMemory(
  state: OrchestratorRunState,
  approvedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>
): Promise<{
  ok: boolean;
  paidItems: Array<{
    feed_item_id: string;
    source_url: string;
    payment_ref: string | null;
    settlement_ref: string | null;
    amount_usdc: number;
  }>;
  failedPayments: Array<{
    feed_item_id: string;
    source_url: string;
    error: string;
  }>;
  error: string | null;
}> {
  if (approvedItems.length === 0) {
    addProgressSummary(state, "Settlement: no approved items to route.");
    return {
      ok: true,
      paidItems: [],
      failedPayments: [],
      error: null,
    };
  }

  // ── Payment Router ──
  const routerInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "payment_router",
    payload: {
      approved_items: approvedItems,
      discovery_run_id: state.discoveryRunId,
      routeTier: state.routeTier,
    },
  };

  const routerResult = await SERVICE_HANDLERS.payment_router(routerInput);
  addServiceEvaluation(state, {
    serviceName: "payment_router",
    macroNode: "settlement_memory",
    input: routerInput.payload,
    output: routerResult.data,
    safeSummary: routerResult.safeSummary,
    status: routerResult.ok ? "completed" : "failed",
    costUsdc: 0.000001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: routerResult.error,
  });
  updateBudgetSnapshot(state, "payment_router", 0.000001);

  if (!routerResult.ok || !routerResult.data) {
    return {
      ok: false,
      paidItems: [],
      failedPayments: [],
      error: `Payment router failed: ${routerResult.error}`,
    };
  }

  const routerData = routerResult.data as {
    paid_items: Array<{
      feed_item_id: string;
      source_url: string;
      payment_ref: string | null;
      settlement_ref: string | null;
      amount_usdc: number;
    }>;
    failed_payments: Array<{
      feed_item_id: string;
      source_url: string;
      error: string;
    }>;
  };

  // Record payment edges
  for (const paid of routerData.paid_items) {
    const edge: PaymentEdge = {
      edgeId: randomUUID(),
      buyerServiceName: "payment_decider",
      sellerServiceName: "payment_router",
      amountUsdc: paid.amount_usdc,
      status: paid.payment_ref ? "executed" : "planned",
      paymentRef: paid.payment_ref,
      settlementRef: paid.settlement_ref,
    };
    state.paymentEdges.push(edge);
  }

  // Store consensus decisions
  for (const item of approvedItems) {
    state.consensusDecisions.push({
      decisionId: randomUUID(),
      macroNode: "settlement_memory",
      serviceName: "payment_router",
      approved: true,
      reason: `Routed: ${item.source_title}`,
      score: item.final_score,
      riskScore: item.risk_score,
      estimatedSpendUsdc: item.approved_price_usdc,
    });
  }

  const summary = `Settlement: ${routerData.paid_items.length} items routed, ${routerData.failed_payments.length} failed. Mode: audit.`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    paidItems: routerData.paid_items,
    failedPayments: routerData.failed_payments,
    error: null,
  };
}
