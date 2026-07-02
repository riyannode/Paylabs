import { supabaseAdmin } from "@/lib/paylabs/db/server";
import type { WriteVisibilityInput } from "./types";
import {
  edgeMode,
  safeEdgeStatus,
  sumPaidUsdc,
  lastPaidTx,
  paidEdges,
} from "./types";

// ─── Preflight payment snapshot for Platform x402 Volume ────

type PreflightPaymentSnapshot = {
  isPreflight: boolean;
  routingPaymentUsdc: number;
  finalEntryPaymentUsdc: number;
  brainTreasuryUsdc: number | null;
  registryCheckCount: number;
  sourceAccessCount: number;
};

function safeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function readPreflightPaymentSnapshot(
  discoveryRunId: string,
): Promise<PreflightPaymentSnapshot> {
  const { data } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("agent_trace, entry_payment_amount_usdc")
    .eq("id", discoveryRunId)
    .single();

  const trace = (data?.agent_trace as Record<string, unknown>) || {};
  const preflight = trace.auto_tier_preflight as Record<string, unknown> | undefined;

  if (!preflight || preflight.status !== "locked") {
    return {
      isPreflight: false,
      routingPaymentUsdc: 0,
      finalEntryPaymentUsdc: 0,
      brainTreasuryUsdc: null,
      registryCheckCount: 0,
      sourceAccessCount: 0,
    };
  }

  const routingPayment = preflight.routing_payment as Record<string, unknown> | undefined;
  const lockedBreakdown = preflight.locked_planned_cost_breakdown as Record<string, unknown> | undefined;

  const routingPaymentUsdc = safeNumber(
    routingPayment?.amount_usdc ?? preflight.routing_fee_usdc,
  );
  const finalEntryPaymentUsdc = safeNumber(
    data?.entry_payment_amount_usdc ?? preflight.final_entry_payment_usdc,
  );
  const brainTreasuryRaw = lockedBreakdown?.brain_treasury_usdc;

  const registryCheckFees = safeNumber(lockedBreakdown?.registry_check_fees_usdc);
  const sourceAccessFees = safeNumber(lockedBreakdown?.source_access_fees_usdc);

  return {
    isPreflight: true,
    routingPaymentUsdc,
    finalEntryPaymentUsdc,
    brainTreasuryUsdc: brainTreasuryRaw == null ? null : safeNumber(brainTreasuryRaw),
    registryCheckCount: Math.round(registryCheckFees / 0.000001),
    sourceAccessCount: Math.round(sourceAccessFees / 0.000001),
  };
}

/**
 * Write canonical x402 visibility rows from orchestrator output.
 * Called by execute-locked route (and legacy inline route).
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

  // ── Run events: run_started + per-edge + run_completed/run_failed ──
  const runEvents: Array<{
    discovery_run_id: string;
    user_wallet: string | null;
    route_tier: string;
    event_type: string;
    actor_type: string;
    actor_name: string;
    target_type: string;
    target_name: string;
    status: string;
    mode: string | null;
    amount_usdc: number | null;
    amount_atomic: null;
    network: null;
    pay_to: string | null;
    x402_version: number | null;
    tx_hash: string | null;
    explorer_url: string | null;
    settlement_id: string | null;
    settlement_url: string | null;
    batch_tx_hash: string | null;
    batch_explorer_url: string | null;
    error: string | null;
    safe_summary: string;
    sequence: number;
    metadata: Record<string, unknown>;
    created_at: string;
  }> = [];

  // run_started event
  runEvents.push({
    discovery_run_id: discoveryRunId,
    user_wallet: userWallet,
    route_tier: routeTier,
    event_type: "run_started",
    actor_type: "controller",
    actor_name: "run_budget_controller",
    target_type: "run",
    target_name: discoveryRunId,
    status: "running",
    mode: null,
    amount_usdc: null,
    amount_atomic: null,
    network: null,
    pay_to: null,
    x402_version: null,
    tx_hash: null,
    explorer_url: null,
    settlement_id: null,
    settlement_url: null,
    batch_tx_hash: null,
    batch_explorer_url: null,
    error: null,
    safe_summary: `Run started: tier=${routeTier}`,
    sequence: 0,
    metadata: {},
    created_at: now,
  });

  // per-edge events
  paymentGraph.forEach((edge, i) => {
    runEvents.push({
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
      settlement_id: edge.settlementId ?? null,
      settlement_url: edge.settlementUrl ?? null,
      batch_tx_hash: edge.batchTxHash ?? null,
      batch_explorer_url: edge.batchExplorerUrl ?? null,
      error: edge.error ?? null,
      safe_summary: `${edge.buyer} → ${edge.seller}: ${edge.status}`,
      sequence: i + 1,
      metadata: {
        gateway_accepted: edge.gatewayAccepted ?? (edge.status === "paid"),
        transfer_status: edge.transferStatus ?? null,
        batch_resolver_url: edge.batchResolverUrl ?? null,
      },
      created_at: now,
    });
  });

  // run_completed or run_failed event
  runEvents.push({
    discovery_run_id: discoveryRunId,
    user_wallet: userWallet,
    route_tier: routeTier,
    event_type: result.status === "completed" ? "run_completed" : "run_failed",
    actor_type: "system",
    actor_name: "paylabs_runtime",
    target_type: "run",
    target_name: discoveryRunId,
    status: result.status === "completed" ? "completed" : "failed",
    mode: null,
    amount_usdc: null,
    amount_atomic: null,
    network: null,
    pay_to: null,
    x402_version: null,
    tx_hash: null,
    explorer_url: null,
    settlement_id: null,
    settlement_url: null,
    batch_tx_hash: null,
    batch_explorer_url: null,
    error: result.error ?? null,
    safe_summary:
      result.status === "completed"
        ? "Run completed"
        : `Run failed: ${result.error ?? "unknown error"}`,
    sequence: runEvents.length,
    metadata: {
      payment_edges: paymentGraph.length,
      payment_plan_items: result.paymentPlan?.length ?? 0,
    },
    created_at: now,
  });

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
    settlement_id: edge.settlementId ?? null,
    settlement_url: edge.settlementUrl ?? null,
    batch_tx_hash: edge.batchTxHash ?? null,
    batch_explorer_url: edge.batchExplorerUrl ?? null,
    error: edge.error ?? null,
    safe_summary: `${edge.buyer} → ${edge.seller}: ${edge.status}`,
    created_at: now,
  }));

  const internalGraphSettledUsdc = sumPaidUsdc(paymentGraph);
  const lastTxHash = lastPaidTx(paymentGraph);
  const paidCount = paidEdges(paymentGraph).length;
  const lastPaid = paidEdges(paymentGraph).slice(-1)[0] ?? null;

  // Platform x402 Volume: for preflight runs, include routing + final entry + internal graph.
  // For legacy inline runs (no preflight trace), use internal graph only.
  const preflightSnapshot = await readPreflightPaymentSnapshot(discoveryRunId);
  const actualSettledUsdc = preflightSnapshot.isPreflight
    ? internalGraphSettledUsdc + preflightSnapshot.routingPaymentUsdc + preflightSnapshot.finalEntryPaymentUsdc
    : internalGraphSettledUsdc;

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
    // Creator distribution V1 fields — derive from split plan, not results.length
    execution_fee_usdc: result.budgetSnapshot?.executionFeeUsdc ?? result.budgetSnapshot?.settledServiceFeesUsdc ?? null,
    planned_creator_pool_usdc: result.creatorDistribution?.plannedCreatorPoolAtomic
      ? (Number(result.creatorDistribution.plannedCreatorPoolAtomic) / 1e6)
      : null,
    actual_creator_paid_usdc: result.creatorDistribution?.actualCreatorPaidUsdc ?? null,
    planned_creator_payout_count: result.creatorDistribution?.plannedCreatorPayoutCount ?? null,
    actual_creator_payout_count: result.creatorDistribution?.payoutResults.filter(
      (r) => r.status === "paid" || r.status === "gateway_accepted"
    ).length ?? null,
    pending_creator_reserve_usdc: result.creatorDistribution?.pendingReserveAtomic
      ? (Number(result.creatorDistribution.pendingReserveAtomic) / 1e6)
      : null,
    bot_share_usdc: result.creatorDistribution?.botShareResult
      && (result.creatorDistribution.botShareResult.status === "paid" || result.creatorDistribution.botShareResult.status === "gateway_accepted")
      ? result.creatorDistribution.botShareResult.amount_usdc
      : 0,
    service_share_usdc: result.creatorDistribution?.serviceShareResult
      && (result.creatorDistribution.serviceShareResult.status === "paid" || result.creatorDistribution.serviceShareResult.status === "gateway_accepted")
      ? result.creatorDistribution.serviceShareResult.amount_usdc
      : 0,
    creator_split_policy: routeTier !== "easy" ? "85_10_5_atomic_safe" : null,
    creator_payout_status: result.creatorDistribution?.payoutResults.some(
      (r) => r.status === "paid" || r.status === "gateway_accepted"
    ) ? "partial_or_complete" : (routeTier !== "easy" ? "none" : null),
    advanced_evaluator_used: result.creatorDistribution?.advancedEvaluatorStatus === "completed",
    advanced_evaluator_confidence: routeTier === "advanced"
      ? ((result.creatorDistribution?.evaluatorOutput as Record<string, unknown>)?.evaluator_confidence as number ?? null)
      : null,
    advanced_evaluator_rationale: routeTier === "advanced"
      ? ((result.creatorDistribution?.evaluatorOutput as Record<string, unknown>)?.user_facing_rationale as string ?? null)
      : null,
    why_two_sources_needed: routeTier === "advanced"
      ? ((result.creatorDistribution?.evaluatorOutput as Record<string, unknown>)?.why_two_sources_needed as string ?? null)
      : null,
    // End creator fields
    payment_count: paidCount,
    last_tx_hash: lastTxHash,
    last_explorer_url: lastPaid?.explorerUrl ?? null,
    last_settlement_id: lastPaid?.settlementId ?? null,
    last_settlement_url: lastPaid?.settlementUrl ?? null,
    last_batch_tx_hash: lastPaid?.batchTxHash ?? null,
    last_batch_explorer_url: lastPaid?.batchExplorerUrl ?? null,
    last_payment_at: paidCount > 0 ? now : null,
    safe_receipt_summary:
      `This quote includes ${preflightSnapshot.registryCheckCount} registry checks and ${preflightSnapshot.sourceAccessCount} source accesses. ` +
      `Each unit costs 0.000001 USDC and is included in User Cost. ` +
      `Run Total equals User Cost plus internal agent payments.`,
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
