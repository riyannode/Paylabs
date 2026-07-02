/**
 * Creator Payout Executor
 *
 * Executes real payouts through server-side Circle/DCW/x402/Gateway path.
 *
 * Rules:
 * - No local private keys
 * - No raw secrets in logs
 * - No raw signatures in DB
 * - No fake settlement metadata
 * - If Gateway accepts/queues transfer, record gateway_accepted and settlement_id
 * - If final batch tx not available yet, keep batch tx fields null
 * - If payment fails, status = failed with safe error
 */

import type {
  CreatorSplitPlan,
  CreatorPayoutResult,
} from "./types";
import { USDC_DECIMALS } from "./split-policy";
import { supabaseAdmin } from "@/lib/paylabs/db/server";

// ─── Payment Transport Interface ──────────────────────────────

export interface CreatorPaymentTransportResult {
  ok: boolean;
  status: "paid" | "gateway_accepted" | "pending" | "failed";
  settlementId?: string | null;
  settlementUrl?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  batchTxHash?: string | null;
  batchExplorerUrl?: string | null;
  error?: string | null;
}

export interface CreatorPaymentTransport {
  transfer(params: {
    toAddress: string;
    amountAtomic: string;
    metadata: Record<string, string>;
  }): Promise<CreatorPaymentTransportResult>;
}

// ─── Payout Executor ──────────────────────────────────────────

export interface ExecuteCreatorPayoutsInput {
  discoveryRunId: string;
  splitPlan: CreatorSplitPlan;
  transport: CreatorPaymentTransport;
}

/**
 * Execute creator payouts through server-side payment transport.
 *
 * Each creator gets 17 atomic (0.000017 USDC).
 * Bot gets 2 atomic per creator slot.
 * Service gets 1 atomic per creator slot.
 */
export async function executeCreatorPayouts(
  input: ExecuteCreatorPayoutsInput
): Promise<CreatorPayoutResult[]> {
  const { discoveryRunId, splitPlan, transport } = input;
  const results: CreatorPayoutResult[] = [];

  for (const item of splitPlan.creator_items) {
    try {
      // Validate wallet before attempting payment
      if (
        !item.creator_wallet ||
        !/^0x[0-9a-fA-F]{40}$/.test(item.creator_wallet)
      ) {
        results.push({
          feed_item_id: item.feed_item_id,
          source_url: item.source_url,
          creator_wallet: item.creator_wallet,
          amount_atomic: item.creator_amount_atomic.toString(),
          amount_usdc: item.creator_amount_usdc,
          status: "failed",
          settlement_id: null,
          settlement_url: null,
          tx_hash: null,
          explorer_url: null,
          batch_tx_hash: null,
          batch_explorer_url: null,
          error: "invalid_creator_wallet",
        });
        continue;
      }

      const paymentResult = await transport.transfer({
        toAddress: item.creator_wallet,
        amountAtomic: item.creator_amount_atomic.toString(),
        metadata: {
          discovery_run_id: discoveryRunId,
          source_url: item.source_url,
          payment_type: "creator_distribution",
          split_index: String(item.split_index),
        },
      });

      results.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: paymentResult.status,
        settlement_id: paymentResult.settlementId ?? null,
        settlement_url: paymentResult.settlementUrl ?? null,
        tx_hash: paymentResult.txHash ?? null,
        explorer_url: paymentResult.explorerUrl ?? null,
        batch_tx_hash: paymentResult.batchTxHash ?? null,
        batch_explorer_url: paymentResult.batchExplorerUrl ?? null,
        error: paymentResult.error ?? null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: "failed",
        settlement_id: null,
        settlement_url: null,
        tx_hash: null,
        explorer_url: null,
        batch_tx_hash: null,
        batch_explorer_url: null,
        error: `payout_execution_error: ${msg}`,
      });
    }
  }

  return results;
}

// ─── Bot Revenue Share ────────────────────────────────────────

export interface ExecuteBotShareInput {
  discoveryRunId: string;
  amountAtomic: bigint;
  botWalletAddress: string;
  transport: CreatorPaymentTransport;
}

export interface ExecuteBotShareResult {
  status: "paid" | "gateway_accepted" | "pending" | "failed";
  amount_atomic: string;
  amount_usdc: number;
  settlement_id: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  error: string | null;
}

export async function executeBotRevenueShare(
  input: ExecuteBotShareInput
): Promise<ExecuteBotShareResult> {
  const amountUsdc = Number(input.amountAtomic) / 10 ** USDC_DECIMALS;

  if (input.amountAtomic === BigInt(0)) {
    return {
      status: "paid",
      amount_atomic: "0",
      amount_usdc: 0,
      settlement_id: null,
      tx_hash: null,
      explorer_url: null,
      error: null,
    };
  }

  try {
    const result = await input.transport.transfer({
      toAddress: input.botWalletAddress,
      amountAtomic: input.amountAtomic.toString(),
      metadata: {
        discovery_run_id: input.discoveryRunId,
        payment_type: "bot_revenue_share",
      },
    });

    return {
      status: result.status,
      amount_atomic: input.amountAtomic.toString(),
      amount_usdc: amountUsdc,
      settlement_id: result.settlementId ?? null,
      tx_hash: result.txHash ?? null,
      explorer_url: result.explorerUrl ?? null,
      error: result.error ?? null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      amount_atomic: input.amountAtomic.toString(),
      amount_usdc: amountUsdc,
      settlement_id: null,
      tx_hash: null,
      explorer_url: null,
      error: `bot_share_error: ${msg}`,
    };
  }
}

// ─── Service Revenue Share ────────────────────────────────────

export interface ExecuteServiceShareInput {
  discoveryRunId: string;
  amountAtomic: bigint;
  serviceWalletAddress: string;
  transport: CreatorPaymentTransport;
}

export interface ExecuteServiceShareResult {
  status: "paid" | "gateway_accepted" | "pending" | "failed";
  amount_atomic: string;
  amount_usdc: number;
  settlement_id: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  error: string | null;
}

export async function executeServiceRevenueShare(
  input: ExecuteServiceShareInput
): Promise<ExecuteServiceShareResult> {
  const amountUsdc = Number(input.amountAtomic) / 10 ** USDC_DECIMALS;

  if (input.amountAtomic === BigInt(0)) {
    return {
      status: "paid",
      amount_atomic: "0",
      amount_usdc: 0,
      settlement_id: null,
      tx_hash: null,
      explorer_url: null,
      error: null,
    };
  }

  try {
    const result = await input.transport.transfer({
      toAddress: input.serviceWalletAddress,
      amountAtomic: input.amountAtomic.toString(),
      metadata: {
        discovery_run_id: input.discoveryRunId,
        payment_type: "service_revenue_share",
      },
    });

    return {
      status: result.status,
      amount_atomic: input.amountAtomic.toString(),
      amount_usdc: amountUsdc,
      settlement_id: result.settlementId ?? null,
      tx_hash: result.txHash ?? null,
      explorer_url: result.explorerUrl ?? null,
      error: result.error ?? null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      amount_atomic: input.amountAtomic.toString(),
      amount_usdc: amountUsdc,
      settlement_id: null,
      tx_hash: null,
      explorer_url: null,
      error: `service_share_error: ${msg}`,
    };
  }
}

// ─── Persist Payout Events ────────────────────────────────────

export async function writeCreatorPayoutEvent(input: {
  discoveryRunId: string;
  routeTier: string;
  result: CreatorPayoutResult;
  splitPolicy: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = supabaseAdmin();

  const isPaid = input.result.status === "paid" || input.result.status === "gateway_accepted";

  // Idempotent: skip if legacy row already exists for this run + feed_item
  const { data: existing, error: checkError } = await db
    .from("paylabs_creator_payout_events")
    .select("id")
    .eq("discovery_run_id", input.discoveryRunId)
    .eq("feed_item_id", input.result.feed_item_id)
    .maybeSingle();

  if (checkError) {
    console.error("[creator-payout-event-write] existence check error:", checkError.message);
    return { ok: false, error: `payout_event_check_failed: ${checkError.message}` };
  }

  if (existing) {
    // Already recorded — skip duplicate insert
    return { ok: true };
  }

  const { error } = await db.from("paylabs_creator_payout_events").insert({
    discovery_run_id: input.discoveryRunId,
    route_tier: input.routeTier,
    feed_item_id: input.result.feed_item_id,
    source_url: input.result.source_url,
    creator_wallet: input.result.creator_wallet,
    status: input.result.status,
    planned_amount_atomic: input.result.amount_atomic,
    planned_amount_usdc: input.result.amount_usdc,
    actual_amount_atomic: isPaid ? input.result.amount_atomic : null,
    actual_amount_usdc: isPaid ? input.result.amount_usdc : null,
    split_policy: input.splitPolicy,
    settlement_id: input.result.settlement_id,
    settlement_url: input.result.settlement_url,
    tx_hash: input.result.tx_hash,
    explorer_url: input.result.explorer_url,
    batch_tx_hash: input.result.batch_tx_hash,
    batch_explorer_url: input.result.batch_explorer_url,
    error: input.result.error,
    safe_summary: `Creator payout ${input.result.status}: ${input.result.amount_usdc.toFixed(6)} USDC`,
    metadata: {},
  });

  if (error) {
    console.error("[creator-payout-event-write] error:", error.message);
    return { ok: false, error: `payout_event_write_failed: ${error.message}` };
  }
  return { ok: true };
}
