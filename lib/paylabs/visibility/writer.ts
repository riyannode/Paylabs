import { supabaseAdmin } from "@/lib/supabase/server";
import type { WriteVisibilityInput } from "./types";
import {
  edgeMode,
  safeEdgeStatus,
  sumPaidUsdc,
  lastPaidTx,
  paidEdges,
} from "./types";

/**
 * Write canonical x402 visibility rows from orchestrator output.
 * Called after runX402Orchestration() completes in the inline route.
 *
 * Writes:
 *  1. paylabs_run_events — one per payment graph edge
 *  2. paylabs_service_payment_events — one per edge (upsert on discovery_run_id + payment_edge_id)
 *  3. paylabs_receipts — one per run (upsert on discovery_run_id)
 *
 * Does NOT store raw signatures, PAYMENT-SIGNATURE headers, signed payloads,
 * Gateway responses, API keys, entity secrets, or chain-of-thought.
 */
export async function writePayLabsVisibility(
  input: WriteVisibilityInput,
): Promise<void> {
  const { discoveryRunId, userWallet, routeTier, result } = input;
  const now = new Date().toISOString();
  const paymentGraph = result.paymentGraph;

  // ── Run events (one per payment graph edge) ──
  const runEvents = paymentGraph.map((edge, i) => ({
    discovery_run_id: discoveryRunId,
    user_wallet: userWallet,
    route_tier: routeTier,
    event_type: `payment_edge_${edge.status}`,
    actor_type: edge.nodeType,
    actor_name: edge.buyer,
    target_type: "service",
    target_name: edge.seller,
    status: safeEdgeStatus(edge),
    mode: edgeMode(edge),
    amount_usdc: edge.amountUsdc,
    amount_atomic: null,
    network: null,
    pay_to: edge.seller,
    x402_version: 2,
    tx_hash: edge.txHash ?? null,
    explorer_url: edge.explorerUrl ?? null,
    error: edge.error ?? null,
    safe_summary: `${edge.buyer} → ${edge.seller}: ${edge.status}`,
    sequence: i + 1,
    metadata: {},
    created_at: now,
  }));

  // ── Service payment events (one per edge) ──
  const servicePaymentRows = paymentGraph.map((edge) => ({
    discovery_run_id: discoveryRunId,
    payment_edge_id: edge.edgeId,
    buyer: edge.buyer,
    seller: edge.seller,
    node_type: edge.nodeType,
    status: safeEdgeStatus(edge),
    mode: edgeMode(edge),
    amount_usdc: edge.amountUsdc,
    amount_atomic: null,
    network: null,
    pay_to: edge.seller,
    x402_version: 2,
    tx_hash: edge.txHash ?? null,
    explorer_url: edge.explorerUrl ?? null,
    error: edge.error ?? null,
    safe_summary: `${edge.buyer} → ${edge.seller}: ${edge.status}`,
    created_at: now,
  }));

  const actualSettledUsdc = sumPaidUsdc(paymentGraph);
  const lastTxHash = lastPaidTx(paymentGraph);
  const paidCount = paidEdges(paymentGraph).length;

  // ── Receipt ──
  const receipt = {
    discovery_run_id: discoveryRunId,
    user_wallet: userWallet,
    selected_tier: routeTier,
    planned_cost_usdc: result.brainPlanning?.planned_cost_usdc ?? null,
    actual_settled_usdc: actualSettledUsdc,
    remaining_budget_usdc: result.budgetSnapshot?.remainingUsdc ?? null,
    service_fees_usdc: result.budgetSnapshot?.settledServiceFeesUsdc ?? actualSettledUsdc,
    source_fees_usdc: 0,
    creator_reserve_usdc: 0,
    payment_count: paidCount,
    last_tx_hash: lastTxHash,
    last_payment_at: paidCount > 0 ? now : null,
    safe_receipt_summary:
      `PayLabs ${routeTier} run: ${paidCount}/${paymentGraph.length} payment edges paid, ` +
      `${actualSettledUsdc.toFixed(6)} USDC settled.`,
    created_at: now,
  };

  const db = supabaseAdmin();

  // ── Write run events ──
  if (runEvents.length > 0) {
    const { error: eventErr } = await db
      .from("paylabs_run_events")
      .insert(runEvents);
    if (eventErr) throw new Error(`visibility_event_write_failed: ${eventErr.message}`);
  }

  // ── Write service payment events ──
  if (servicePaymentRows.length > 0) {
    const { error: paymentErr } = await db
      .from("paylabs_service_payment_events")
      .upsert(servicePaymentRows, { onConflict: "discovery_run_id,payment_edge_id" });
    if (paymentErr) throw new Error(`service_payment_event_write_failed: ${paymentErr.message}`);
  }

  // ── Write receipt ──
  const { error: receiptErr } = await db
    .from("paylabs_receipts")
    .upsert(receipt, { onConflict: "discovery_run_id" });
  if (receiptErr) throw new Error(`receipt_write_failed: ${receiptErr.message}`);
}
