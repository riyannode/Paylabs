/**
 * Withdrawal Ledger
 *
 * CRUD operations for paylabs_gateway_withdrawals table.
 * Uses compare-and-set (CAS) transitions for concurrency safety.
 */

import { supabaseAdmin } from "../db/server";
import type { WithdrawalRow, WithdrawalStatus, WalletMode, BurnIntent } from "./gateway-types";

// ─── Create ──────────────────────────────────────────────────

export interface CreateWithdrawalInput {
  walletMode: WalletMode;
  ownerRef: string;
  walletId: string;
  walletAddress: string;
  amountAtomic: string;
  amountUsdc: number;
  idempotencyKey: string;
  burnIntent: BurnIntent;
  burnIntentHash: string;
  transferSpecHash: string | null;
  gatewayFee: string | null;
  gatewayExpiration: number | null;
}

/**
 * Create a new withdrawal row. Fails on duplicate idempotency key.
 */
export async function createWithdrawal(
  input: CreateWithdrawalInput,
): Promise<{ ok: boolean; row?: WithdrawalRow; error?: string }> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("paylabs_gateway_withdrawals")
    .insert({
      wallet_mode: input.walletMode,
      owner_ref: input.ownerRef,
      wallet_id: input.walletId,
      wallet_address: input.walletAddress.toLowerCase(),
      amount_atomic: input.amountAtomic,
      amount_usdc: input.amountUsdc,
      idempotency_key: input.idempotencyKey,
      status: "prepared",
      burn_intent: input.burnIntent,
      burn_intent_hash: input.burnIntentHash,
      transfer_spec_hash: input.transferSpecHash,
      gateway_fee: input.gatewayFee,
      gateway_expiration: input.gatewayExpiration,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      // Unique constraint violation — idempotency key already exists
      // Return existing row
      const { data: existing } = await db
        .from("paylabs_gateway_withdrawals")
        .select("*")
        .eq("wallet_mode", input.walletMode)
        .eq("wallet_id", input.walletId)
        .eq("idempotency_key", input.idempotencyKey)
        .single();

      if (existing) {
        return { ok: true, row: existing as WithdrawalRow };
      }
      return { ok: false, error: "Idempotency key conflict but row not found" };
    }
    return { ok: false, error: `Failed to create withdrawal: ${error.message}` };
  }

  return { ok: true, row: data as WithdrawalRow };
}

// ─── Read ────────────────────────────────────────────────────

/**
 * Get a withdrawal by ID with ownership verification.
 */
export async function getWithdrawal(
  withdrawalId: string,
  walletMode: WalletMode,
  ownerRef: string,
): Promise<{ row: WithdrawalRow | null; error?: string }> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("paylabs_gateway_withdrawals")
    .select("*")
    .eq("id", withdrawalId)
    .eq("wallet_mode", walletMode)
    .eq("owner_ref", ownerRef)
    .single();

  if (error) {
    return { row: null, error: `Withdrawal not found: ${error.message}` };
  }

  return { row: data as WithdrawalRow };
}

// ─── CAS Status Update ───────────────────────────────────────

/**
 * Compare-and-set status transition.
 * Only succeeds if the current status matches `expectedStatus`.
 */
export async function casUpdateStatus(
  withdrawalId: string,
  expectedStatus: WithdrawalStatus,
  nextStatus: WithdrawalStatus,
): Promise<{ ok: boolean; error?: string }> {
  const db = supabaseAdmin();

  const { error } = await db
    .from("paylabs_gateway_withdrawals")
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq("id", withdrawalId)
    .eq("status", expectedStatus);

  if (error) {
    return { ok: false, error: `CAS update failed: ${error.message}` };
  }

  return { ok: true };
}

// ─── Field Updates ───────────────────────────────────────────

export interface UpdateWithdrawalFields {
  status?: WithdrawalStatus;
  signingChallengeId?: string;
  gatewayTransferId?: string;
  attestationHash?: string;
  mintChallengeId?: string;
  mintIdempotencyKey?: string;
  circleTransactionId?: string;
  txHash?: string;
  explorerUrl?: string;
  gasPreflightOk?: boolean;
  gasPreflightFee?: string;
  gasPreflightError?: string;
  errorCode?: string;
  errorMessage?: string;
  safeMetadata?: Record<string, unknown>;
}

/**
 * Update specific fields on a withdrawal row.
 * Uses CAS on status if status is provided.
 */
export async function updateWithdrawal(
  withdrawalId: string,
  fields: UpdateWithdrawalFields,
  expectedStatus?: WithdrawalStatus,
): Promise<{ ok: boolean; error?: string }> {
  const db = supabaseAdmin();

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.signingChallengeId !== undefined) updates.signing_challenge_id = fields.signingChallengeId;
  if (fields.gatewayTransferId !== undefined) updates.gateway_transfer_id = fields.gatewayTransferId;
  if (fields.attestationHash !== undefined) updates.attestation_hash = fields.attestationHash;
  if (fields.mintChallengeId !== undefined) updates.mint_challenge_id = fields.mintChallengeId;
  if (fields.mintIdempotencyKey !== undefined) updates.mint_idempotency_key = fields.mintIdempotencyKey;
  if (fields.circleTransactionId !== undefined) updates.circle_transaction_id = fields.circleTransactionId;
  if (fields.txHash !== undefined) updates.tx_hash = fields.txHash;
  if (fields.explorerUrl !== undefined) updates.explorer_url = fields.explorerUrl;
  if (fields.gasPreflightOk !== undefined) updates.gas_preflight_ok = fields.gasPreflightOk;
  if (fields.gasPreflightFee !== undefined) updates.gas_preflight_fee = fields.gasPreflightFee;
  if (fields.gasPreflightError !== undefined) updates.gas_preflight_error = fields.gasPreflightError;
  if (fields.errorCode !== undefined) updates.error_code = fields.errorCode;
  if (fields.errorMessage !== undefined) updates.error_message = fields.errorMessage;
  if (fields.safeMetadata !== undefined) updates.safe_metadata = fields.safeMetadata;

  let query = db
    .from("paylabs_gateway_withdrawals")
    .update(updates)
    .eq("id", withdrawalId);

  if (expectedStatus) {
    query = query.eq("status", expectedStatus);
  }

  const { error } = await query;

  if (error) {
    return { ok: false, error: `Update failed: ${error.message}` };
  }

  return { ok: true };
}

// ─── Reconciliation Queries ──────────────────────────────────

/**
 * Find withdrawals that may need reconciliation.
 */
export async function findReconcilableWithdrawals(): Promise<WithdrawalRow[]> {
  const db = supabaseAdmin();
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 minutes ago

  const { data, error } = await db
    .from("paylabs_gateway_withdrawals")
    .select("*")
    .in("status", ["gateway_submitted", "mint_submitted"])
    .lt("updated_at", cutoff);

  if (error || !data) return [];
  return data as WithdrawalRow[];
}
