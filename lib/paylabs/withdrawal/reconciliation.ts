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
import { getGatewayTransferById, computeBurnIntentDigest } from "./gateway-transfer";
import { explorerUrl } from "./explorer";
import { GATEWAY_MINTER_ADDRESS } from "./gateway-types";
import type { WithdrawalRow } from "./gateway-types";

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

async function retryDcwMint(row: WithdrawalRow, newIdempotencyKey = false): Promise<boolean> {
  if (!row.gateway_transfer_id || !row.mint_idempotency_key) return false;

  // Recover attestation from Gateway
  const transfer = await getGatewayTransferById(row.gateway_transfer_id);
  if (!transfer.ok || !transfer.data) return false;

  const { status: transferStatus, attestationPayload, attestationSignature, expirationBlock } = transfer.data;

  // Check Gateway transfer status — don't retry if already confirmed/finalized
  if (transferStatus === "CONFIRMED" || transferStatus === "FINALIZED") return false;
  // Don't retry if expired
  if (transferStatus === "EXPIRED") return false;
  // Don't retry if attestation is missing
  if (!attestationPayload || !attestationSignature) return false;

  // For confirmed terminal failure, use a new idempotency key
  const idempotencyKey = newIdempotencyKey
    ? crypto.randomUUID()
    : row.mint_idempotency_key;

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
        expectedStatus: row.status as any,
        circleTransactionId: mintTxId,
        mintIdempotencyKey: idempotencyKey,
        safeMetadata: {
          ...((row.safe_metadata as Record<string, unknown>) || {}),
          retryAttempt: ((row.safe_metadata as any)?.retryAttempt || 0) + 1,
          previousTransactionId: row.circle_transaction_id || null,
        },
      });
      return casResult.ok;
    }
  } catch { /* retry failed */ }
  return false;
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
          const retried = await retryDcwMint(row, true); // new key for confirmed failure
          if (!retried) {
            await updateWithdrawal(id, {
              status: "failed", expectedStatus: "mint_submitted",
              errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txResult.state}`,
              txHash: txResult.txHash ?? undefined,
            });
          }
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

    // Case 2: attestation_received / reconciliation_required with transferId — retry mint
    if ((status === "attestation_received" || status === "reconciliation_required" || status === "mint_submission_pending") && gateway_transfer_id) {
      const transfer = await getGatewayTransferById(gateway_transfer_id);
      if (transfer.ok && transfer.data?.attestationPayload) {
        const { status: transferStatus } = transfer.data;
        // Don't retry if transfer is expired or confirmed/finalized
        if (transferStatus !== "EXPIRED" && transferStatus !== "CONFIRMED" && transferStatus !== "FINALIZED") {
          // Ambiguous retry: use same key. Confirmed failure: use new key.
          const isNewKey = status === "reconciliation_required";
          const retried = await retryDcwMint(row, isNewKey);
          if (retried) return;
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
  // Only handle gateway timeout
  if (status === "gateway_submitted") {
    await updateWithdrawal(id, {
      status: "reconciliation_required", expectedStatus: "gateway_submitted",
      errorCode: "gateway_timeout", errorMessage: "Gateway submission timed out",
    });
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
