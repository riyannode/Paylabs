/**
 * Creator Payout Ledger — Idempotent claim-before-transfer pattern.
 *
 * Canonical ledger for all creator/bot/service payouts and treasury tracking.
 * Unique constraint on (discovery_run_id, payout_type, payout_subject_id)
 * prevents double-payout on retry.
 *
 * Rules:
 * - claimPending() creates a pending row FIRST (idempotent via upsert)
 * - If row already exists with paid/gateway_accepted → skip transfer
 * - If row already exists with pending → fail closed (concurrent claim)
 * - markPaid/markFailed update ONLY after real x402 result
 * - Never mark paid without real payment metadata
 * - No raw secrets, no raw signatures, no raw Gateway responses
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Types ────────────────────────────────────────────────────

export type PayoutType =
  | "creator_share"
  | "bot_share"
  | "service_share"
  | "unallocated_reserve"
  | "treasury_retained";

export type PayoutStatus =
  | "pending"
  | "paid"
  | "gateway_accepted"
  | "failed"
  | "skipped";

export interface PayoutLedgerRow {
  id: string;
  discovery_run_id: string;
  payout_type: PayoutType;
  payout_subject_id: string;
  status: PayoutStatus;
  amount_atomic: string;
  amount_usdc: number;
  wallet_address: string | null;
  route_tier: string | null;
  settlement_id: string | null;
  settlement_url: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  reason: string | null;
  error: string | null;
  safe_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ClaimPendingInput {
  discoveryRunId: string;
  payoutType: PayoutType;
  payoutSubjectId: string;
  amountAtomic: string;
  amountUsdc: number;
  walletAddress?: string | null;
  routeTier?: string | null;
  safeMetadata?: Record<string, unknown>;
}

export interface ClaimPendingResult {
  ok: boolean;
  action: "claimed" | "already_completed" | "already_pending" | "error";
  row?: PayoutLedgerRow;
  error?: string;
}

export interface MarkPayoutResultInput {
  discoveryRunId: string;
  payoutType: PayoutType;
  payoutSubjectId: string;
  status: "paid" | "gateway_accepted" | "failed";
  settlementId?: string | null;
  settlementUrl?: string | null;
  txHash?: string | null;
  explorerUrl?: string | null;
  batchTxHash?: string | null;
  batchExplorerUrl?: string | null;
  error?: string | null;
}

// ─── Claim Pending ────────────────────────────────────────────

/**
 * Claim a pending payout slot (idempotent).
 *
 * - If no row exists → insert pending row, return "claimed"
 * - If row exists with paid/gateway_accepted → return "already_completed"
 * - If row exists with pending → return "already_pending" (concurrent claim)
 * - If row exists with failed/skipped → update to pending, return "claimed" (retry)
 */
export async function claimPending(
  input: ClaimPendingInput,
): Promise<ClaimPendingResult> {
  const db = supabaseAdmin();

  // Check for existing row
  const { data: existing, error: fetchError } = await db
    .from("paylabs_payout_ledger")
    .select("*")
    .eq("discovery_run_id", input.discoveryRunId)
    .eq("payout_type", input.payoutType)
    .eq("payout_subject_id", input.payoutSubjectId)
    .maybeSingle();

  if (fetchError) {
    return {
      ok: false,
      action: "error",
      error: `ledger_fetch_failed: ${fetchError.message}`,
    };
  }

  // Already completed — skip transfer
  if (
    existing &&
    (existing.status === "paid" || existing.status === "gateway_accepted")
  ) {
    return {
      ok: true,
      action: "already_completed",
      row: existing as PayoutLedgerRow,
    };
  }

  // Already pending — concurrent claim, fail closed
  if (existing && existing.status === "pending") {
    return {
      ok: false,
      action: "already_pending",
      row: existing as PayoutLedgerRow,
      error: `concurrent_claim: ${input.payoutType}/${input.payoutSubjectId} already pending`,
    };
  }

  const now = new Date().toISOString();

  // No existing row → insert pending
  if (!existing) {
    const { data: inserted, error: insertError } = await db
      .from("paylabs_payout_ledger")
      .insert({
        discovery_run_id: input.discoveryRunId,
        payout_type: input.payoutType,
        payout_subject_id: input.payoutSubjectId,
        status: "pending",
        amount_atomic: input.amountAtomic,
        amount_usdc: input.amountUsdc,
        wallet_address: input.walletAddress ?? null,
        route_tier: input.routeTier ?? null,
        safe_metadata: input.safeMetadata ?? {},
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (insertError) {
      // Unique constraint violation = concurrent insert (race condition)
      if (insertError.code === "23505") {
        return {
          ok: false,
          action: "already_pending",
          error: `race_condition: ${input.payoutType}/${input.payoutSubjectId} claimed by concurrent request`,
        };
      }
      return {
        ok: false,
        action: "error",
        error: `ledger_insert_failed: ${insertError.message}`,
      };
    }

    return {
      ok: true,
      action: "claimed",
      row: inserted as PayoutLedgerRow,
    };
  }

  // Existing row with failed/skipped → retry: atomic compare-and-swap
  // .in("status", ["failed", "skipped"]) ensures only ONE concurrent retry wins.
  // If two retries read the same failed row, only the first to update claims it.
  const { data: updated, error: updateError } = await db
    .from("paylabs_payout_ledger")
    .update({
      status: "pending",
      amount_atomic: input.amountAtomic,
      amount_usdc: input.amountUsdc,
      wallet_address: input.walletAddress ?? null,
      route_tier: input.routeTier ?? null,
      safe_metadata: input.safeMetadata ?? {},
      error: null,
      settlement_id: null,
      settlement_url: null,
      tx_hash: null,
      explorer_url: null,
      batch_tx_hash: null,
      batch_explorer_url: null,
      updated_at: now,
    })
    .eq("discovery_run_id", input.discoveryRunId)
    .eq("payout_type", input.payoutType)
    .eq("payout_subject_id", input.payoutSubjectId)
    .in("status", ["failed", "skipped"]) // CAS: only update if still failed/skipped
    .select()
    .maybeSingle(); // Returns null if no row matched (someone else claimed it)

  if (updateError) {
    return {
      ok: false,
      action: "error",
      error: `ledger_retry_update_failed: ${updateError.message}`,
    };
  }

  // No row matched = concurrent retry already claimed it
  if (!updated) {
    return {
      ok: false,
      action: "already_pending",
      error: `concurrent_retry: ${input.payoutType}/${input.payoutSubjectId} already claimed by another retry`,
    };
  }

  return {
    ok: true,
    action: "claimed",
    row: updated as PayoutLedgerRow,
  };
}

// ─── Mark Payout Result ──────────────────────────────────────

/**
 * Update ledger row with real x402 payment result.
 * Only called AFTER transfer completes.
 */
export async function markPayoutResult(
  input: MarkPayoutResultInput,
): Promise<{ ok: boolean; error?: string }> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  const { error } = await db
    .from("paylabs_payout_ledger")
    .update({
      status: input.status,
      settlement_id: input.settlementId ?? null,
      settlement_url: input.settlementUrl ?? null,
      tx_hash: input.txHash ?? null,
      explorer_url: input.explorerUrl ?? null,
      batch_tx_hash: input.batchTxHash ?? null,
      batch_explorer_url: input.batchExplorerUrl ?? null,
      error: input.error ?? null,
      updated_at: now,
    })
    .eq("discovery_run_id", input.discoveryRunId)
    .eq("payout_type", input.payoutType)
    .eq("payout_subject_id", input.payoutSubjectId)
    .eq("status", "pending"); // Only update pending rows

  if (error) {
    return { ok: false, error: `ledger_mark_failed: ${error.message}` };
  }
  return { ok: true };
}

// ─── Get Existing Payout ─────────────────────────────────────

/**
 * Check if a payout already exists for a given run + type + subject.
 */
export async function getExistingPayout(
  discoveryRunId: string,
  payoutType: PayoutType,
  payoutSubjectId: string,
): Promise<PayoutLedgerRow | null> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("paylabs_payout_ledger")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .eq("payout_type", payoutType)
    .eq("payout_subject_id", payoutSubjectId)
    .maybeSingle();

  if (error || !data) return null;
  return data as PayoutLedgerRow;
}

// ─── Record Unallocated Reserve ──────────────────────────────

/**
 * Record unallocated creator pool funds (no x402 transfer).
 * Called when eligible creator count < payout limit.
 */
export async function recordUnallocatedReserve(input: {
  discoveryRunId: string;
  routeTier: string;
  amountAtomic: string;
  amountUsdc: number;
  reason: string;
  safeMetadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; error?: string }> {
  const result = await claimPending({
    discoveryRunId: input.discoveryRunId,
    payoutType: "unallocated_reserve",
    payoutSubjectId: "unallocated_reserve",
    amountAtomic: input.amountAtomic,
    amountUsdc: input.amountUsdc,
    routeTier: input.routeTier,
    safeMetadata: {
      ...(input.safeMetadata ?? {}),
      unallocated_reason: input.reason,
    },
  });

  if (!result.ok && result.action !== "already_completed") {
    return { ok: false, error: result.error };
  }

  // If newly claimed (not already recorded), mark as skipped immediately
  if (result.action === "claimed") {
    const db = supabaseAdmin();
    await db
      .from("paylabs_payout_ledger")
      .update({
        status: "skipped",
        reason: input.reason,
        updated_at: new Date().toISOString(),
      })
      .eq("discovery_run_id", input.discoveryRunId)
      .eq("payout_type", "unallocated_reserve")
      .eq("payout_subject_id", "unallocated_reserve")
      .eq("status", "pending"); // Only update our own pending row
  }

  return { ok: true };
}

// ─── Delete Ledger Row ───────────────────────────────────────

/**
 * Delete a specific ledger row. Used to clear stale bot/service share
 * when paid creator count changes on retry, or stale reserve rows.
 * Only deletes rows that are NOT paid/gateway_accepted (safety).
 */
export async function deleteLedgerRow(
  discoveryRunId: string,
  payoutType: PayoutType,
  payoutSubjectId: string,
): Promise<{ ok: boolean; deleted: boolean; error?: string }> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("paylabs_payout_ledger")
    .delete()
    .eq("discovery_run_id", discoveryRunId)
    .eq("payout_type", payoutType)
    .eq("payout_subject_id", payoutSubjectId)
    .not("status", "in", '("paid","gateway_accepted")') // Never delete completed rows
    .select("id");

  if (error) {
    return { ok: false, deleted: false, error: `ledger_delete_failed: ${error.message}` };
  }
  return { ok: true, deleted: (data?.length ?? 0) > 0 };
}

// ─── List Payouts for Run ────────────────────────────────────

/**
 * List all ledger rows for a discovery run.
 */
export async function listPayoutLedgerForRun(
  discoveryRunId: string,
): Promise<PayoutLedgerRow[]> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("paylabs_payout_ledger")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];
  return data as PayoutLedgerRow[];
}
