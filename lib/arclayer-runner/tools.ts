// ArcLayer Runner tools for PayLabs
// Higher-level wrappers around Runner client for source payment flows.
// All privileged payment actions go through Runner — never directly to Circle/contracts.

import { runnerHealth, runnerX402Quote, runnerFetch, runnerGetPaymentReceipt } from "./client";
import type { RunnerX402PayResult, RunnerPaymentReceipt } from "./types";
import { RunnerError } from "./types";

/**
 * Check if Runner is configured and reachable.
 * Returns false if env vars missing or Runner unhealthy.
 */
export async function isRunnerAvailable(): Promise<boolean> {
  try {
    const health = await runnerHealth();
    return health.ok === true;
  } catch {
    return false;
  }
}

/**
 * Execute source payment through ArcLayer Runner.
 * This is the ONLY path for source payments.
 *
 * Never uses local private keys.
 * Never generates fallback payment IDs.
 * Returns structured result — caller must validate proof completeness.
 */
export async function executeSourcePaymentViaRunner(input: {
  userWallet: string;
  sourcePathId: string;
  sourcePathItemId: string;
  amountUsdc: string;
  creatorWallet: string;
  sourceUrl: string;
  inputHash: string;
}): Promise<RunnerX402PayResult> {
  // Validate inputs
  if (!input.userWallet.startsWith("0x") || input.userWallet.length !== 42) {
    throw new RunnerError("Invalid user wallet address", 400);
  }
  if (!input.creatorWallet.startsWith("0x") || input.creatorWallet.length !== 42) {
    throw new RunnerError("Invalid creator wallet address", 400);
  }
  if (!input.sourceUrl) {
    throw new RunnerError("Missing sourceUrl", 400);
  }
  if (!input.amountUsdc || Number(input.amountUsdc) <= 0) {
    throw new RunnerError("Invalid amount", 400);
  }

  const available = await isRunnerAvailable();
  if (!available) {
    throw new RunnerError("ArcLayer Runner is not available", 503);
  }

  // Deterministic idempotency key
  const idempotencyKey = `source-payment:${input.sourcePathId}:${input.sourcePathItemId}:${input.userWallet}`;

  const result = await runnerFetch<RunnerX402PayResult>("POST", "/x402/pay", {
    type: "source_payment",
    url: input.sourceUrl,
    method: "GET",
    maxAmountUsdc: input.amountUsdc,
    reason: `source-payment:${input.sourcePathItemId}`,
    idempotencyKey,
    body: {
      sourcePathId: input.sourcePathId,
      sourcePathItemId: input.sourcePathItemId,
      userWallet: input.userWallet,
      creatorWallet: input.creatorWallet,
      inputHash: input.inputHash,
    },
  });

  if (!result.ok) {
    throw new RunnerError(
      `Payment failed: ${result.error || "Unknown error"}`,
      402
    );
  }

  // CRITICAL: Validate Runner returned a complete payment proof
  if (!result.paymentId) {
    throw new RunnerError(
      "Runner payment proof incomplete: missing paymentId",
      502
    );
  }
  if (!result.paymentRef && !result.settlementRef) {
    throw new RunnerError(
      "Runner payment proof incomplete: missing paymentRef and settlementRef",
      502
    );
  }

  return result;
}

/**
 * Get settlement receipt for a completed payment.
 * Used to verify payment was settled by Circle Gateway.
 */
export async function getPaymentReceipt(
  paymentId: string
): Promise<RunnerPaymentReceipt> {
  if (!paymentId) {
    throw new RunnerError("Missing paymentId", 400);
  }

  return runnerGetPaymentReceipt(paymentId);
}
