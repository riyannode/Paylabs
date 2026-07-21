/**
 * Withdrawal Reconciliation
 *
 * Finds stuck withdrawals and attempts to resolve their status.
 * Covers: gateway_submitted, attestation_received, mint_approval_pending,
 * mint_submitted, reconciliation_required.
 *
 * For DCW: polls Circle transaction directly.
 * For UCW: requires userToken (not available in server-side reconciliation);
 *          marks as reconciliation_required for frontend to resolve.
 */

import { createRequire } from "node:module";
import { findReconcilableWithdrawals, updateWithdrawal, getWithdrawal } from "./ledger";
import { explorerUrl } from "./explorer";
import type { WithdrawalRow, WalletMode } from "./gateway-types";

const _require = createRequire(import.meta.url);

// ─── DCW Transaction Polling ─────────────────────────────────

const TERMINAL_STATES = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED", "STUCK"]);
const SUCCESS_STATES = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE_STATES = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);

async function pollDcwTransaction(circleTransactionId: string): Promise<{
  state: string;
  txHash: string | null;
}> {
  try {
    const mod = _require("@circle-fin/developer-controlled-wallets");
    const client = mod.initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
    const resp = await client.getTransaction({ id: circleTransactionId });
    const tx = resp?.data?.transaction;
    return {
      state: tx?.state || "UNKNOWN",
      txHash: tx?.txHash || null,
    };
  } catch {
    return { state: "UNKNOWN", txHash: null };
  }
}

// ─── Reconcile Single Withdrawal ─────────────────────────────

async function reconcileWithdrawal(row: WithdrawalRow): Promise<void> {
  const { id, wallet_mode, status, circle_transaction_id, gateway_transfer_id } = row;

  // DCW: has circle_transaction_id → poll it
  if (wallet_mode === "dcw" && circle_transaction_id && (status === "mint_submitted" || status === "reconciliation_required")) {
    const txResult = await pollDcwTransaction(circle_transaction_id);

    if (SUCCESS_STATES.has(txResult.state)) {
      await updateWithdrawal(id, {
        status: "finalized",
        expectedStatus: status,
        txHash: txResult.txHash ?? undefined,
        explorerUrl: explorerUrl(txResult.txHash) ?? undefined,
      });
    } else if (FAILURE_STATES.has(txResult.state)) {
      // If we had attestation, this is a mint failure — can retry
      if (status === "reconciliation_required" && gateway_transfer_id) {
        // Keep as reconciliation_required for retry
        return;
      }
      await updateWithdrawal(id, {
        status: "failed",
        expectedStatus: status,
        errorCode: "circle_tx_failed",
        errorMessage: `Circle transaction: ${txResult.state}`,
        txHash: txResult.txHash ?? undefined,
      });
    }
    return;
  }

  // gateway_submitted without attestation → timeout
  if (status === "gateway_submitted") {
    await updateWithdrawal(id, {
      status: "reconciliation_required",
      expectedStatus: "gateway_submitted",
      errorCode: "gateway_timeout",
      errorMessage: "Gateway submission timed out without attestation response",
    });
    return;
  }

  // attestation_received without mint challenge → needs frontend or manual retry
  if (status === "attestation_received") {
    // Cannot proceed server-side without mint challenge
    // Mark as reconciliation_required for manual resolution
    await updateWithdrawal(id, {
      status: "reconciliation_required",
      expectedStatus: "attestation_received",
      errorCode: "mint_not_created",
      errorMessage: "Attestation received but mint challenge was never created",
    });
    return;
  }

  // mint_approval_pending → UCW, needs frontend to execute sdk.execute()
  // Cannot resolve server-side — leave as is for frontend polling
}

// ─── Main Reconciliation Entry Point ─────────────────────────

export async function runReconciliation(): Promise<{
  processed: number;
  errors: number;
  finalized: number;
  failed: number;
}> {
  const rows = await findReconcilableWithdrawals();
  let errors = 0;
  let finalized = 0;
  let failed = 0;

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
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[reconcile] Error:", row.id, msg.slice(0, 200));
    }
  }

  return { processed: rows.length, errors, finalized, failed };
}
