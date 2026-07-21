/**
 * Withdrawal Reconciliation
 *
 * Handles stuck withdrawals with wallet-specific logic:
 * - DCW: polls Circle transaction, retries mint with recovered attestation
 * - UCW: cannot poll server-side (needs userToken); marks for frontend resolution
 *
 * Retry semantics:
 * - Ambiguous/no-response: retry with same idempotency key
 * - Confirmed terminal failure: new idempotency key, preserve previous tx ID
 */

import { createRequire } from "node:module";
import { findReconcilableWithdrawals, updateWithdrawal, getWithdrawal, casUpdateStatus } from "./ledger";
import { supabaseAdmin } from "../db/server";
import { getGatewayTransferById, computeBurnIntentDigest } from "./gateway-transfer";
import { explorerUrl } from "./explorer";
import { GATEWAY_MINTER_ADDRESS } from "./gateway-types";
import type { WithdrawalRow, WithdrawalStatus, WalletMode } from "./gateway-types";

const _require = createRequire(import.meta.url);

const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);
const TERMINAL = new Set([...SUCCESS, ...FAILURE]);

// ─── DCW Client ──────────────────────────────────────────────

let _dcwClient: any = null;
function getDcwClient() {
  if (_dcwClient) return _dcwClient;
  const mod = _require("@circle-fin/developer-controlled-wallets");
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
  return _dcwClient;
}

// ─── DCW Transaction Polling ─────────────────────────────────

async function pollDcwTxOnce(txId: string): Promise<{ state: string; txHash: string | null }> {
  try {
    const client = getDcwClient();
    const resp = await client.getTransaction({ id: txId });
    const tx = resp?.data?.transaction;
    return { state: tx?.state || "UNKNOWN", txHash: tx?.txHash || null };
  } catch {
    return { state: "UNKNOWN", txHash: null };
  }
}

// ─── DCW Mint Retry ──────────────────────────────────────────

export type RetryDcwResult =
  | { kind: "finalized"; txHash?: string }
  | { kind: "retried" }
  | { kind: "reconciliation_required"; reason: string }
  | { kind: "failed"; reason: string };

async function retryDcwMint(row: WithdrawalRow, newIdempotencyKey = false): Promise<RetryDcwResult> {
  if (!row.gateway_transfer_id || !row.mint_idempotency_key) {
    return { kind: "reconciliation_required", reason: "missing_transfer_or_key" };
  }

  // Recover attestation from Gateway
  const transfer = await getGatewayTransferById(row.gateway_transfer_id);
  if (!transfer.ok || !transfer.data) {
    return { kind: "reconciliation_required", reason: "gateway_get_failed" };
  }

  const { status: rawStatus, attestationPayload, attestationSignature, transactionHash } = transfer.data;

  // Normalize Gateway status — API returns lowercase
  const transferStatus = (rawStatus || "").toLowerCase();

  // Gateway confirmed/finalized = destination mint exists → finalize
  if (transferStatus === "confirmed" || transferStatus === "finalized") {
    return { kind: "finalized", txHash: transactionHash || undefined };
  }

  // Gateway explicitly failed/expired → do not call gatewayMint
  if (transferStatus === "failed") {
    return { kind: "failed", reason: "gateway_failed" };
  }
  if (transferStatus === "expired") {
    return { kind: "failed", reason: "gateway_expired" };
  }

  // Unknown/empty status → must not mint
  if (transferStatus !== "pending") {
    return { kind: "reconciliation_required", reason: `gateway_unknown_status: ${transferStatus}` };
  }

  // Only retry if attestation is present
  if (!attestationPayload || !attestationSignature) {
    return { kind: "reconciliation_required", reason: "missing_attestation" };
  }

  // ─── ALWAYS CAS gate through mint_submission_pending ────
  const idempotencyKey = newIdempotencyKey
    ? crypto.randomUUID()
    : row.mint_idempotency_key;

  const casGate = await updateWithdrawal(row.id, {
    status: "mint_submission_pending",
    expectedStatus: row.status as any,
    mintIdempotencyKey: idempotencyKey,
    ...(newIdempotencyKey ? {
      safeMetadata: {
        ...((row.safe_metadata as Record<string, unknown>) || {}),
        retryAttempt: ((row.safe_metadata as any)?.retryAttempt || 0) + 1,
        previousTransactionId: row.circle_transaction_id || null,
      },
    } : {}),
  });
  if (!casGate.ok) {
    return { kind: "reconciliation_required", reason: "cas_conflict" };
  }

  const currentStatus: WithdrawalStatus = "mint_submission_pending";

  try {
    const client = getDcwClient();
    const mintTx = await client.createContractExecutionTransaction({
      walletId: row.wallet_id,
      contractAddress: GATEWAY_MINTER_ADDRESS,
      abiFunctionSignature: "gatewayMint(bytes,bytes)",
      abiParameters: [attestationPayload, attestationSignature],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey,
    });
    const mintTxId = mintTx?.data?.id;
    if (mintTxId) {
      const casResult = await updateWithdrawal(row.id, {
        status: "mint_submitted",
        expectedStatus: currentStatus,
        circleTransactionId: mintTxId,
        mintIdempotencyKey: idempotencyKey,
      });
      if (casResult.ok) return { kind: "retried" };
      return { kind: "reconciliation_required", reason: "post_cas_conflict" };
    }
    // No tx ID returned — ambiguous
    await updateWithdrawal(row.id, {
      status: "reconciliation_required",
      expectedStatus: currentStatus,
      errorCode: "mint_no_tx_id",
      errorMessage: "Retry returned no transaction ID (ambiguous)",
      mintIdempotencyKey: idempotencyKey,
    });
    return { kind: "reconciliation_required", reason: "mint_no_tx_id" };
  } catch {
    // Request timed out or failed — ambiguous
    await updateWithdrawal(row.id, {
      status: "reconciliation_required",
      expectedStatus: currentStatus,
      errorCode: "mint_submission_failed",
      errorMessage: "Retry request failed (ambiguous)",
      mintIdempotencyKey: idempotencyKey,
    });
    return { kind: "reconciliation_required", reason: "mint_submission_failed" };
  }
}

// ─── Monotonic Recovery Helper ─────────────────────────────────

/**
 * Guarded recovery: persists an external reference (gateway_transfer_id, attestation_hash,
 * mint_challenge_id, etc.) with monotonic state transition.
 * - Verifies wallet ownership
 * - Permits only explicitly allowed current statuses
 * - Persists the external reference (with select().maybeSingle() to detect zero-row updates)
 * - Verifies each requested reference was actually persisted
 * - Performs a monotonic state transition (never regresses)
 * - Returns the actual persisted row
 */
export async function monotonicRecoveryPersist(
  withdrawalId: string,
  walletMode: WalletMode,
  ownerRef: string,
  allowedCurrentStatuses: WithdrawalStatus[],
  fields: { gatewayTransferId?: string; attestationHash?: string; mintChallengeId?: string; mintIdempotencyKey?: string; circleTransactionId?: string; },
  nextStatus: WithdrawalStatus,
  acceptableLaterStatuses: WithdrawalStatus[] = [],
): Promise<{ ok: boolean; row?: WithdrawalRow; error?: string }> {
  // 1. Verify ownership
  const { row, error: loadError } = await getWithdrawal(withdrawalId, walletMode, ownerRef);
  if (loadError || !row) return { ok: false, error: "Withdrawal not found" };

  // 2. Verify current status is in allowed set (prevents regression)
  if (!allowedCurrentStatuses.includes(row.status)) {
    return { ok: false, error: `Status '${row.status}' not in allowed recovery statuses` };
  }

  // 3. Persist external references with select().maybeSingle() to detect zero-row updates
  const db = supabaseAdmin();
  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.gatewayTransferId !== undefined) updatePayload.gateway_transfer_id = fields.gatewayTransferId;
  if (fields.attestationHash !== undefined) updatePayload.attestation_hash = fields.attestationHash;
  if (fields.mintChallengeId !== undefined) updatePayload.mint_challenge_id = fields.mintChallengeId;
  if (fields.mintIdempotencyKey !== undefined) updatePayload.mint_idempotency_key = fields.mintIdempotencyKey;
  if (fields.circleTransactionId !== undefined) updatePayload.circle_transaction_id = fields.circleTransactionId;

  const { data: updatedRow, error: updateError } = await db
    .from("paylabs_gateway_withdrawals")
    .update(updatePayload)
    .eq("id", withdrawalId)
    .eq("wallet_mode", walletMode)
    .eq("owner_ref", ownerRef)
    .eq("status", row.status)
    .select()
    .maybeSingle();

  if (updateError) return { ok: false, error: `Recovery persist failed: ${updateError.message}` };
  if (!updatedRow) return { ok: false, error: "Recovery persist: zero rows matched (concurrent status change)" };

  // 4. Verify each requested external reference was actually persisted
  if (fields.gatewayTransferId !== undefined && updatedRow.gateway_transfer_id !== fields.gatewayTransferId) {
    return { ok: false, error: `Verification failed: gateway_transfer_id expected '${fields.gatewayTransferId}' got '${updatedRow.gateway_transfer_id}'` };
  }
  if (fields.attestationHash !== undefined && updatedRow.attestation_hash !== fields.attestationHash) {
    return { ok: false, error: `Verification failed: attestation_hash expected '${fields.attestationHash}' got '${updatedRow.attestation_hash}'` };
  }
  if (fields.mintChallengeId !== undefined && updatedRow.mint_challenge_id !== fields.mintChallengeId) {
    return { ok: false, error: `Verification failed: mint_challenge_id expected '${fields.mintChallengeId}' got '${updatedRow.mint_challenge_id}'` };
  }
  if (fields.mintIdempotencyKey !== undefined && updatedRow.mint_idempotency_key !== fields.mintIdempotencyKey) {
    return { ok: false, error: `Verification failed: mint_idempotency_key expected '${fields.mintIdempotencyKey}' got '${updatedRow.mint_idempotency_key}'` };
  }
  if (fields.circleTransactionId !== undefined && updatedRow.circle_transaction_id !== fields.circleTransactionId) {
    return { ok: false, error: `Verification failed: circle_transaction_id expected '${fields.circleTransactionId}' got '${updatedRow.circle_transaction_id}'` };
  }

  // 5. Monotonic state transition via CAS
  const casResult = await updateWithdrawal(withdrawalId, {
    status: nextStatus,
    expectedStatus: row.status,
  });

  if (casResult.ok && casResult.row) {
    // Verify the CAS result actually reached nextStatus
    if (casResult.row.status === nextStatus) {
      return { ok: true, row: casResult.row };
    }
    // Status is in acceptable later statuses — another recovery path won the race
    if (acceptableLaterStatuses.includes(casResult.row.status)) {
      return { ok: true, row: casResult.row };
    }
    // Row remained at original status or unexpected status — recovery did not advance
    return { ok: false, row: casResult.row, error: `CAS target not reached: status is '${casResult.row.status}', expected '${nextStatus}'` };
  }
  // CAS failed — re-read to check if already at target or acceptable later status
  const { row: afterRow } = await getWithdrawal(withdrawalId, walletMode, ownerRef);
  if (afterRow && (afterRow.status === nextStatus || acceptableLaterStatuses.includes(afterRow.status))) {
    // Verify references are present
    const refsOk =
      (fields.gatewayTransferId === undefined || afterRow.gateway_transfer_id === fields.gatewayTransferId) &&
      (fields.attestationHash === undefined || afterRow.attestation_hash === fields.attestationHash) &&
      (fields.mintChallengeId === undefined || afterRow.mint_challenge_id === fields.mintChallengeId) &&
      (fields.mintIdempotencyKey === undefined || afterRow.mint_idempotency_key === fields.mintIdempotencyKey) &&
      (fields.circleTransactionId === undefined || afterRow.circle_transaction_id === fields.circleTransactionId);
    if (refsOk) {
      return { ok: true, row: afterRow };
    }
  }
  return { ok: false, row: afterRow || undefined, error: casResult.error };
}

// ─── Reconcile Single Withdrawal ─────────────────────────────

async function reconcileWithdrawal(row: WithdrawalRow): Promise<void> {
  const { id, wallet_mode, status, circle_transaction_id, gateway_transfer_id } = row;

  // ── DCW wallet-specific handling ──────────────────────────
  if (wallet_mode === "dcw") {
    // Case 1: mint_submitted — poll Circle transaction
    if (status === "mint_submitted" && circle_transaction_id) {
      const txResult = await pollDcwTxOnce(circle_transaction_id);
      if (SUCCESS.has(txResult.state)) {
        const casResult = await updateWithdrawal(id, {
          status: "finalized", expectedStatus: "mint_submitted",
          txHash: txResult.txHash ?? undefined, explorerUrl: explorerUrl(txResult.txHash) ?? undefined,
        });
        if (!casResult.ok) console.error("[reconcile] CAS failed finalizing:", casResult.error);
      } else if (FAILURE.has(txResult.state)) {
        // Mint failed — check if attestation is retryable
        if (gateway_transfer_id) {
          const result = await retryDcwMint(row, true); // new key for confirmed failure
          if (result.kind === "finalized") {
            await updateWithdrawal(id, {
              status: "finalized", expectedStatus: "mint_submitted",
              txHash: result.txHash ?? txResult.txHash ?? undefined,
              explorerUrl: explorerUrl(result.txHash ?? txResult.txHash) ?? undefined,
            });
          } else if (result.kind === "failed") {
            await updateWithdrawal(id, {
              status: "failed", expectedStatus: "mint_submitted",
              errorCode: result.reason, errorMessage: `Circle tx: ${txResult.state}, ${result.reason}`,
              txHash: txResult.txHash ?? undefined,
            });
          }
          // result.kind === "reconciliation_required" or "retried" — already persisted by retryDcwMint
        } else {
          await updateWithdrawal(id, {
            status: "failed", expectedStatus: "mint_submitted",
            errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txResult.state}`,
            txHash: txResult.txHash ?? undefined,
          });
        }
      }
      return;
    }

    // Case 2: attestation_received / reconciliation_required / mint_submission_pending with transferId — retry mint
    if ((status === "attestation_received" || status === "reconciliation_required" || status === "mint_submission_pending") && gateway_transfer_id) {
      const transfer = await getGatewayTransferById(gateway_transfer_id);
      if (transfer.ok && transfer.data) {
        // P0-1: Normalize Gateway status to lowercase
        const transferStatus = (transfer.data.status || "").toLowerCase();
        // P0-3: Gateway confirmed/finalized → finalize from Gateway, don't retry
        if (transferStatus === "confirmed" || transferStatus === "finalized") {
          await updateWithdrawal(id, {
            status: "finalized", expectedStatus: status,
            txHash: transfer.data.transactionHash ?? undefined,
            explorerUrl: explorerUrl(transfer.data.transactionHash) ?? undefined,
          });
          return;
        }
        // Only retry if transfer is pending with valid attestation
        const hasAttestation = !!transfer.data.attestationPayload && !!transfer.data.attestationSignature;
        if (transferStatus === "pending" && hasAttestation) {
          // P0-2: Retry key logic — check error_code, not just status
          // Only confirmed terminal failures create a NEW key.
          // Ambiguous/no-response cases (mint_submission_failed, mint_no_tx_id,
          // timeout, response lost, crash after request) reuse the SAME key.
          const isNewKey = status === "reconciliation_required"
            && row.error_code !== "mint_submission_failed"
            && row.error_code !== "mint_no_tx_id"
            && row.error_code !== "gateway_timeout"
            && row.error_code !== "mint_submission_pending"
            && row.error_code !== "cas_recovery";
          const result = await retryDcwMint(row, isNewKey);
          if (result.kind === "finalized") {
            await updateWithdrawal(id, {
              status: "finalized", expectedStatus: status,
              txHash: result.txHash ?? transfer.data.transactionHash ?? undefined,
              explorerUrl: explorerUrl(result.txHash ?? transfer.data.transactionHash) ?? undefined,
            });
          } else if (result.kind === "failed") {
            await updateWithdrawal(id, {
              status: "failed", expectedStatus: status,
              errorCode: result.reason, errorMessage: `Gateway: ${result.reason}, Circle transfer: ${transferStatus}`,
            });
          }
          // result.kind === "reconciliation_required" or "retried" — already persisted by retryDcwMint
          return;
        }
      }
      return;
    }

    // Case 3: gateway_submitted without attestation — timeout
    if (status === "gateway_submitted") {
      await updateWithdrawal(id, {
        status: "reconciliation_required", expectedStatus: "gateway_submitted",
        errorCode: "gateway_timeout", errorMessage: "Gateway submission timed out",
      });
      return;
    }

    return; // DCW done
  }

  // ── UCW wallet-specific handling ──────────────────────────
  // UCW cannot be polled server-side (needs userToken from session)
  // Leave mint_approval_pending and mint_submitted for frontend resolution
  // Only handle gateway timeout and challenge recovery

  // Case: gateway_submitted without attestation — timeout
  if (status === "gateway_submitted") {
    await updateWithdrawal(id, {
      status: "reconciliation_required", expectedStatus: "gateway_submitted",
      errorCode: "gateway_timeout", errorMessage: "Gateway submission timed out",
    });
    return;
  }

  // P0-4b: UCW recovery for mint_submission_pending with persisted mintIdempotencyKey
  // Runtime crashed after persisting key but before createGatewayMintChallenge succeeded.
  // Re-use the SAME persisted key to call createGatewayMintChallenge.
  if (status === "mint_submission_pending" && row.mint_idempotency_key && !row.mint_challenge_id) {
    // Cannot recover without userToken — mark for frontend retry
    // Frontend must re-call sign endpoint which will use the persisted key
    return;
  }

  // P0-4b: UCW recovery for reconciliation_required with persisted mintIdempotencyKey but no mintChallengeId
  if (status === "reconciliation_required" && row.mint_idempotency_key && !row.mint_challenge_id) {
    // Cannot recover without userToken — leave for frontend resolution
    // Frontend can re-trigger the mint flow using the persisted mintIdempotencyKey
    return;
  }

  // attestation_received without mint challenge → needs frontend
  // mint_approval_pending → needs frontend sdk.execute()
  // mint_submitted → needs frontend to call /mint endpoint
}

// ─── Main Entry Point ────────────────────────────────────────

export async function runReconciliation(): Promise<{
  processed: number; errors: number; finalized: number; failed: number;
}> {
  const rows = await findReconcilableWithdrawals();
  let errors = 0, finalized = 0, failed = 0;

  for (const row of rows) {
    try {
      const before = row.status;
      await reconcileWithdrawal(row);
      const { row: after } = await getWithdrawal(row.id, row.wallet_mode, row.owner_ref);
      if (after?.status === "finalized") finalized++;
      if (after?.status === "failed") failed++;
      if (after?.status !== before) {
        console.info(`[reconcile] ${row.id} (${row.wallet_mode}): ${before} → ${after?.status}`);
      }
    } catch (e: unknown) {
      errors++;
      console.error("[reconcile] Error:", row.id, (e as Error).message?.slice(0, 200));
    }
  }

  return { processed: rows.length, errors, finalized, failed };
}
