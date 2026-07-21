/**
 * Withdrawal Reconciliation
 *
 * Finds stuck withdrawals and attempts to resolve their status.
 * Runs periodically or on-demand.
 */

import { supabaseAdmin } from "../db/server";
import { findReconcilableWithdrawals, updateWithdrawal } from "./ledger";
import { explorerUrl } from "./explorer";
import type { WithdrawalRow } from "./gateway-types";

// ─── DCW Transaction Polling ─────────────────────────────────

/**
 * Poll a DCW Circle transaction for terminal state.
 * Uses the DCW SDK getTransaction method.
 */
async function pollDcwTransaction(
  circleTransactionId: string,
): Promise<{ state: string; txHash: string | null }> {
  const { createRequire } = await import("node:module");
  const _require = createRequire(import.meta.url);
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
}

// ─── UCW Challenge Resolution ────────────────────────────────

/**
 * Resolve a UCW mint challenge to a Circle transaction ID.
 */
async function resolveUcwMintChallenge(
  userToken: string,
  mintChallengeId: string,
): Promise<{ transactionId: string | null; state: string | null }> {
  const { createRequire } = await import("node:module");
  const _require = createRequire(import.meta.url);
  const mod = _require("@circle-fin/user-controlled-wallets");
  const client = mod.initiateUserControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
  });

  // Get challenge to find correlationIds
  const challengeResp = await client.getUserChallenge({
    userToken,
    challengeId: mintChallengeId,
  });

  const challenge = challengeResp?.data?.challenge;
  const correlationId = challenge?.correlationIds?.[0];

  if (!correlationId) {
    return { transactionId: null, state: null };
  }

  // Get transaction by correlation ID
  const txResp = await client.getTransaction({
    userToken,
    id: correlationId,
  });

  const tx = txResp?.data?.transaction;
  return {
    transactionId: tx?.id || null,
    state: tx?.state || null,
  };
}

// ─── Terminal State Check ────────────────────────────────────

const TERMINAL_SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);

function isTerminalSuccess(state: string): boolean {
  return TERMINAL_SUCCESS.has(state);
}

function isTerminalFailure(state: string): boolean {
  return TERMINAL_FAILURE.has(state);
}

// ─── Reconcile Single Withdrawal ─────────────────────────────

async function reconcileWithdrawal(row: WithdrawalRow): Promise<void> {
  const { id, wallet_mode, status, circle_transaction_id, mint_challenge_id } = row;

  try {
    if (status === "mint_submitted" && circle_transaction_id) {
      // Poll Circle transaction
      let state: string;
      let txHash: string | null;

      if (wallet_mode === "dcw") {
        const result = await pollDcwTransaction(circle_transaction_id);
        state = result.state;
        txHash = result.txHash;
      } else {
        // UCW — need userToken from session (not available in reconciliation)
        // Skip — will be handled by frontend polling
        return;
      }

      if (isTerminalSuccess(state)) {
        await updateWithdrawal(id, {
          status: "finalized",
          txHash: txHash ?? undefined,
          explorerUrl: explorerUrl(txHash) ?? undefined,
        });
      } else if (isTerminalFailure(state)) {
        await updateWithdrawal(id, {
          status: "failed",
          errorCode: "circle_tx_failed",
          errorMessage: `Circle transaction reached terminal state: ${state}`,
          txHash: txHash ?? undefined,
        });
      }
      // else: still pending, leave as is
    } else if (status === "gateway_submitted") {
      // Gateway submitted but no attestation yet — may need manual check
      // Leave as reconciliation_required for now
      await updateWithdrawal(id, {
        status: "reconciliation_required",
        errorCode: "gateway_timeout",
        errorMessage: "Gateway submission timed out without attestation response",
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[reconcile] Error reconciling withdrawal:", id, msg.slice(0, 200));
  }
}

// ─── Main Reconciliation Entry Point ─────────────────────────

/**
 * Run reconciliation on all stuck withdrawals.
 * Returns the number of withdrawals processed.
 */
export async function runReconciliation(): Promise<{ processed: number; errors: number }> {
  const rows = await findReconcilableWithdrawals();
  let errors = 0;

  for (const row of rows) {
    try {
      await reconcileWithdrawal(row);
    } catch {
      errors++;
    }
  }

  return { processed: rows.length, errors };
}
