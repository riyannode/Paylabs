/**
 * PayLabs Backend Payment Executor — Tools
 *
 * Higher-level wrappers around the executor client for source payment flows.
 * All payment execution goes through the executor — never directly to Circle.
 *
 * Uses Circle DCW signer + Circle Gateway x402 under the hood.
 */

import { executorHealth, executorX402Quote, executorFetch, executorGetPaymentReceipt } from "./client";
import type { PaymentExecutorX402PayResult, PaymentExecutorReceipt } from "./types";
import { PaymentExecutorError } from "./types";

/**
 * Check if the backend payment executor is configured and reachable.
 * Returns false if env vars missing or executor unhealthy.
 */
export async function isExecutorAvailable(): Promise<boolean> {
  try {
    const health = await executorHealth();
    return health.ok === true;
  } catch {
    return false;
  }
}

/**
 * Execute source payment through the backend payment executor.
 * This is the ONLY path for source payments.
 *
 * Uses Circle DCW signer for signing and Circle Gateway x402 for settlement.
 * Never uses local private keys.
 * Never generates fallback payment IDs.
 * Returns structured result — caller must validate proof completeness.
 */
export async function executeSourcePaymentViaExecutor(input: {
  userWallet: string;
  sourcePathId: string;
  sourcePathItemId: string;
  amountUsdc: string;
  creatorWallet: string;
  sourceUrl: string;
  inputHash: string;
}): Promise<PaymentExecutorX402PayResult> {
  // Validate inputs
  if (!input.userWallet.startsWith("0x") || input.userWallet.length !== 42) {
    throw new PaymentExecutorError("Invalid user wallet address", 400);
  }
  if (!input.creatorWallet.startsWith("0x") || input.creatorWallet.length !== 42) {
    throw new PaymentExecutorError("Invalid creator wallet address", 400);
  }
  if (!input.sourceUrl) {
    throw new PaymentExecutorError("Missing sourceUrl", 400);
  }
  if (!input.amountUsdc || Number(input.amountUsdc) <= 0) {
    throw new PaymentExecutorError("Invalid amount", 400);
  }

  const available = await isExecutorAvailable();
  if (!available) {
    throw new PaymentExecutorError("Backend payment executor is not available", 503);
  }

  // Deterministic idempotency key
  const idempotencyKey = `source-payment:${input.sourcePathId}:${input.sourcePathItemId}:${input.userWallet}`;

  const result = await executorFetch<PaymentExecutorX402PayResult>("POST", "/x402/pay", {
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
    throw new PaymentExecutorError(
      `Payment failed: ${result.error || "Unknown error"}`,
      402
    );
  }

  // CRITICAL: Validate executor returned a complete payment proof
  if (!result.paymentId) {
    throw new PaymentExecutorError(
      "Payment proof incomplete: missing paymentId",
      502
    );
  }
  if (!result.paymentRef && !result.settlementRef) {
    throw new PaymentExecutorError(
      "Payment proof incomplete: missing paymentRef and settlementRef",
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
): Promise<PaymentExecutorReceipt> {
  if (!paymentId) {
    throw new PaymentExecutorError("Missing paymentId", 400);
  }

  return executorGetPaymentReceipt(paymentId);
}
