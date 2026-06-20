/**
 * Nanopayment Service
 *
 * Manages DB operations for agent nanopayments and batch settlements.
 * Reads/writes paylabs_agent_nanopayments and paylabs_agent_batch_settlements.
 *
 * No real fund movement — all payment refs come from Gateway/Circle
 * when flags are enabled. When flags are false, status = "planned" or "skipped".
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  PAID_AGENTS,
  AGENT_NANOPRICE_USDC,
  AGENT_COUNT,
  type PaidAgentName,
} from "@/lib/paylabs/agent-registry";
import {
  getDiscoveryFeeTier,
  type ExternalRouteTier,
} from "@/lib/paylabs/route-tier";

// ─── Types ─────────────────────────────────────────────────────

export interface NanopaymentRow {
  id: string;
  discovery_run_id: string;
  receipt_id: string;
  user_wallet: string;
  payer_agent: string;
  payee_agent: string;
  route_tier: string;
  agent_name: string;
  capability: string;
  agent_wallet: string;
  price_usdc: number;
  settlement_mode: string;
  payment_route: string;
  payment_kind: string;
  x402_payment_ref: string | null;
  x402_settlement_ref: string | null;
  circle_transfer_id: string | null;
  receipt_url: string | null;
  status: string;
  created_at: string;
}

export interface BatchSettlementRow {
  id: string;
  discovery_run_id: string;
  route_tier: string;
  agent_count: number;
  agent_total_usdc: number;
  treasury_fee_usdc: number;
  gateway_buffer_usdc: number;
  circle_batch_id: string | null;
  x402_batch_ref: string | null;
  status: string;
  created_at: string;
}

export interface CreateNanopaymentRowsInput {
  discoveryRunId: string;
  userWallet: string;
  routeTier: ExternalRouteTier;
}

export interface CreateBatchSettlementInput {
  discoveryRunId: string;
  routeTier: ExternalRouteTier;
}

// ─── Create Nanopayment Rows ───────────────────────────────────

/**
 * Create 7 planned nanopayment rows for a discovery run.
 * One row per paid agent, each with price 0.000001 USDC.
 * Status starts as "planned" — upgraded when payment is processed.
 */
export async function createNanopaymentRows(
  input: CreateNanopaymentRowsInput
): Promise<{ rows: NanopaymentRow[]; error?: string }> {
  const feeTier = getDiscoveryFeeTier(input.routeTier);

  const rows = PAID_AGENTS.map((agent) => ({
    discovery_run_id: input.discoveryRunId,
    user_wallet: input.userWallet.toLowerCase(),
    payer_agent: "paylabs_treasury",
    payee_agent: agent.name,
    route_tier: input.routeTier,
    agent_name: agent.name,
    capability: agent.capability,
    agent_wallet: process.env[agent.envWalletAddressKey] || "",
    price_usdc: 0.000001,
    settlement_mode: feeTier.settlementMode,
    payment_route: "circle_gateway_x402",
    payment_kind: "agent_capability_fee",
    receipt_url: "", // filled after insert
    status: "planned" as const,
  }));

  const { data, error } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .insert(rows)
    .select("*");

  if (error || !data) {
    return {
      rows: [],
      error: `Failed to create nanopayment rows: ${error?.message}`,
    };
  }

  // Update receipt URLs with actual receipt IDs
  const typedData = data as NanopaymentRow[];
  for (const row of typedData) {
    const receiptUrl = `/api/paylabs/receipts/${row.receipt_id}`;
    await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .update({ receipt_url: receiptUrl })
      .eq("id", row.id);
    row.receipt_url = receiptUrl;
  }

  return { rows: typedData };
}

// ─── Create Batch Settlement ───────────────────────────────────

/**
 * Create a batch settlement record for a discovery run.
 */
export async function createBatchSettlement(
  input: CreateBatchSettlementInput
): Promise<{ row: BatchSettlementRow | null; error?: string }> {
  const feeTier = getDiscoveryFeeTier(input.routeTier);

  const { data, error } = await supabaseAdmin()
    .from("paylabs_agent_batch_settlements")
    .insert({
      discovery_run_id: input.discoveryRunId,
      route_tier: input.routeTier,
      agent_count: AGENT_COUNT,
      agent_total_usdc: parseFloat(feeTier.agentNanopaymentsUsdc),
      treasury_fee_usdc: parseFloat(feeTier.treasuryFeeUsdc),
      gateway_buffer_usdc: parseFloat(feeTier.gatewayBufferUsdc),
      status: "planned" as const,
    })
    .select("*")
    .single();

  if (error || !data) {
    return {
      row: null,
      error: `Failed to create batch settlement: ${error?.message}`,
    };
  }

  return { row: data as BatchSettlementRow };
}

// ─── Query ─────────────────────────────────────────────────────

/**
 * Get nanopayment rows for a discovery run.
 */
export async function getNanopaymentsByRun(
  discoveryRunId: string
): Promise<NanopaymentRow[]> {
  const { data } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .order("created_at", { ascending: true });

  return (data || []) as NanopaymentRow[];
}

/**
 * Get nanopayment row by receipt ID.
 */
export async function getNanopaymentByReceipt(
  receiptId: string
): Promise<NanopaymentRow | null> {
  const { data } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .select("*")
    .eq("receipt_id", receiptId)
    .single();

  return (data as NanopaymentRow) || null;
}

/**
 * Get batch settlement by discovery run ID.
 */
export async function getBatchSettlementByRun(
  discoveryRunId: string
): Promise<BatchSettlementRow | null> {
  const { data } = await supabaseAdmin()
    .from("paylabs_agent_batch_settlements")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .single();

  return (data as BatchSettlementRow) || null;
}

/**
 * Get all recent nanopayment rows (for dashboard).
 */
export async function getRecentNanopayments(
  limit = 50
): Promise<NanopaymentRow[]> {
  const { data } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data || []) as NanopaymentRow[];
}

/**
 * Get all recent batch settlements (for dashboard).
 */
export async function getRecentBatchSettlements(
  limit = 25
): Promise<BatchSettlementRow[]> {
  const { data } = await supabaseAdmin()
    .from("paylabs_agent_batch_settlements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data || []) as BatchSettlementRow[];
}

/**
 * Update nanopayment status.
 */
export async function updateNanopaymentStatus(
  id: string,
  status: string,
  refs?: { paymentRef?: string; settlementRef?: string; transferId?: string }
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (refs?.paymentRef) update.x402_payment_ref = refs.paymentRef;
  if (refs?.settlementRef) update.x402_settlement_ref = refs.settlementRef;
  if (refs?.transferId) update.circle_transfer_id = refs.transferId;

  await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .update(update)
    .eq("id", id);
}
