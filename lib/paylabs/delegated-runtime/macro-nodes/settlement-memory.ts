/**
 * Settlement & Memory Macro-Node
 *
 * Phase 3 of the delegated runtime.
 * Services: payment_router
 *
 * This phase:
 * 1. Routes approved items through payment_router (via callDelegatedService)
 * 2. Records payment edges (status: planned, not executed)
 * 3. Persists safe evaluation summaries
 *
 * This is ALWAYS audit-only in this PR.
 * x402 real payment is NOT implemented.
 * Status is "payment_plan_ready", not "settled".
 */

import type { OrchestratorRunState, PaymentEdge } from "../types";
import type { ServiceName } from "../../agent-services/types";
import { callDelegatedService } from "../../agent-services/call-delegated-service";
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
  mode: "audit_only";
  settled: false;
  error: string | null;
}> {
  if (approvedItems.length === 0) {
    addProgressSummary(state, "Settlement: no approved items to route. Payment plan empty.");
    return {
      ok: true,
      routedItems: [],
      failedItems: [],
      mode: "audit_only",
      settled: false,
      error: null,
    };
  }

  // ── Payment Router via callDelegatedService ──
  const routerResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "payment_decider",
    sellerServiceName: "payment_router",
    payload: {
      approved_items: approvedItems,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "payment_router",
    macroNode: "settlement_memory",
    input: { approved_items: approvedItems },
    output: routerResult.data,
    safeSummary: routerResult.safeSummary,
    status: routerResult.ok ? "completed" : "failed",
    costUsdc: routerResult.safeCallMeta.costUsdc,
    startedAt: routerResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: routerResult.error,
    settled: routerResult.settled,
    mode: routerResult.mode,
  });
  updateBudgetSnapshot(state, "payment_router", routerResult.safeCallMeta.costUsdc, routerResult.settled);

  if (!routerResult.ok || !routerResult.data) {
    return {
      ok: false,
      routedItems: [],
      failedItems: [],
      mode: "audit_only",
      settled: false,
      error: `Payment router failed: ${routerResult.error}`,
    };
  }

  const routerData = routerResult.data as {
    routed_items: Array<{
      feed_item_id: string;
      source_url: string;
      amount_usdc: number;
      status: "planned";
    }>;
    failed_items: Array<{
      feed_item_id: string;
      source_url: string;
      error: string;
    }>;
  };

  // Record payment edges (status: planned, not executed)
  for (const routed of routerData.routed_items) {
    const edge: PaymentEdge = {
      edgeId: randomUUID(),
      buyerServiceName: "payment_decider",
      sellerServiceName: "payment_router",
      amountUsdc: routed.amount_usdc,
      status: "planned", // audit-only: never "executed"
      paymentRef: null,
      settlementRef: null,
    };
    state.paymentEdges.push(edge);
  }

  // Store consensus decisions
  for (const item of approvedItems) {
    state.consensusDecisions.push({
      decisionId: randomUUID(),
      macroNode: "settlement_memory",
      serviceName: "payment_router" as ServiceName,
      approved: true,
      reason: `Planned (audit-only): ${item.source_title}`,
      score: item.final_score,
      riskScore: item.risk_score,
      estimatedSpendUsdc: item.approved_price_usdc,
    });
  }

  const summary = `Settlement (audit-only): ${routerData.routed_items.length} items planned, ${routerData.failed_items.length} failed validation. Mode: payment_plan_ready. No real payment executed.`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    routedItems: routerData.routed_items,
    failedItems: routerData.failed_items,
    mode: "audit_only",
    settled: false,
    error: null,
  };
}
