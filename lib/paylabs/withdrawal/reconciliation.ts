/**
 * Withdrawal Reconciliation
 *
 * Finds stuck withdrawals and attempts to resolve their status.
 * For attestation_received / reconciliation_required with transferId:
 *   recovers attestation via GET /v1/transfer/{transferId}
 *   and retries mint creation for DCW.
 */

import { createRequire } from "node:module";
import { findReconcilableWithdrawals, updateWithdrawal, getWithdrawal } from "./ledger";
import { getGatewayTransferById, computeBurnIntentDigest } from "./gateway-transfer";
import { explorerUrl } from "./explorer";
import type { WithdrawalRow } from "./gateway-types";

const _require = createRequire(import.meta.url);

const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);
const TERMINAL = new Set([...SUCCESS, ...FAILURE]);

// ─── DCW Transaction Polling ─────────────────────────────────

async function pollDcwTxOnce(txId: string): Promise<{ state: string; txHash: string | null }> {
  try {
    const mod = _require("@circle-fin/developer-controlled-wallets");
    const client = mod.initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
    const resp = await client.getTransaction({ id: txId });
    const tx = resp?.data?.transaction;
    return { state: tx?.state || "UNKNOWN", txHash: tx?.txHash || null };
  } catch {
    return { state: "UNKNOWN", txHash: null };
  }
}

// ─── DCW Mint Retry ──────────────────────────────────────────

async function retryDcwMint(row: WithdrawalRow): Promise<boolean> {
  if (!row.gateway_transfer_id || !row.mint_idempotency_key) return false;

  // Recover attestation from Gateway
  const transfer = await getGatewayTransferById(row.gateway_transfer_id);
  if (!transfer.ok || !transfer.data?.attestationPayload || !transfer.data?.attestationSignature) {
    return false;
  }

  try {
    const mod = _require("@circle-fin/developer-controlled-wallets");
    const client = mod.initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
    const mintTx = await client.createContractExecutionTransaction({
      walletId: row.wallet_id,
      contractAddress: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
      abiFunctionSignature: "gatewayMint(bytes,bytes)",
      abiParameters: [transfer.data.attestationPayload, transfer.data.attestationSignature],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: row.mint_idempotency_key,
    });
    const mintTxId = mintTx?.data?.id;
    if (mintTxId) {
      await updateWithdrawal(row.id, {
        status: "mint_submitted",
        expectedStatus: row.status as any,
        circleTransactionId: mintTxId,
      });
      return true;
    }
  } catch {
    // Retry failed
  }
  return false;
}

// ─── Reconcile Single Withdrawal ─────────────────────────────

async function reconcileWithdrawal(row: WithdrawalRow): Promise<void> {
  const { id, status, circle_transaction_id, gateway_transfer_id } = row;

  // Case 1: mint_submitted — poll Circle transaction
  if (status === "mint_submitted" && circle_transaction_id) {
    const txResult = await pollDcwTxOnce(circle_transaction_id);
    if (SUCCESS.has(txResult.state)) {
      await updateWithdrawal(id, {
        status: "finalized", expectedStatus: "mint_submitted",
        txHash: txResult.txHash ?? undefined, explorerUrl: explorerUrl(txResult.txHash) ?? undefined,
      });
    } else if (FAILURE.has(txResult.state)) {
      // Mint failed but attestation exists — try retry
      if (gateway_transfer_id && row.mint_idempotency_key) {
        const retried = await retryDcwMint(row);
        if (retried) return; // Retry succeeded, will be polled next time
      }
      await updateWithdrawal(id, {
        status: "failed", expectedStatus: "mint_submitted",
        errorCode: "circle_tx_failed", errorMessage: `Circle tx: ${txResult.state}`,
        txHash: txResult.txHash ?? undefined,
      });
    }
    return;
  }

  // Case 2: attestation_received / reconciliation_required — recover attestation and retry mint
  if ((status === "attestation_received" || status === "reconciliation_required") && gateway_transfer_id) {
    const transfer = await getGatewayTransferById(gateway_transfer_id);
    if (transfer.ok && transfer.data?.attestationPayload) {
      // Attestation recovered — retry mint for DCW
      if (row.wallet_mode === "dcw") {
        const retried = await retryDcwMint(row);
        if (retried) return;
      }
      // UCW — cannot retry mint server-side (needs frontend sdk.execute)
      // Keep as reconciliation_required for frontend to handle
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

  // Case 4: mint_approval_pending — UCW, needs frontend
  // Leave as is
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
        console.info(`[reconcile] ${row.id}: ${before} → ${after?.status}`);
      }
    } catch (e: unknown) {
      errors++;
      console.error("[reconcile] Error:", row.id, (e as Error).message?.slice(0, 200));
    }
  }

  return { processed: rows.length, errors, finalized, failed };
}
