// ArcLayer Runner tools for PayLabs
// Higher-level wrappers around Runner client for lesson payment flows.
// All privileged payment actions go through Runner — never directly to Circle/contracts.

import {
  runnerHealth,
  runnerX402Quote,
  runnerX402PayLesson,
  runnerGetPaymentReceipt,
} from "./client";
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
 * Verify x402 payment is possible for a lesson.
 * Returns the quote/challenge from Runner, or throws if not payable.
 */
export async function quoteLessonPayment(
  lessonId: string,
  resourceUrl: string
) {
  const available = await isRunnerAvailable();
  if (!available) {
    throw new RunnerError("ArcLayer Runner is not available", 503);
  }

  return runnerX402Quote(resourceUrl);
}

/**
 * Execute lesson purchase through ArcLayer Runner.
 * This is the ONLY path for agent-initiated lesson purchases.
 *
 * Flow:
 * 1. Verify Runner is available
 * 2. Get x402 quote from Runner
 * 3. Runner executes payment via Circle Developer-Controlled Wallet
 * 4. Return payment result with settlement ref
 *
 * @param userWallet - The user's wallet address (must be 0x...)
 * @param lessonId - The lesson to purchase
 * @param resourceUrl - The x402-protected resource URL
 * @param amountUsdc - Lesson price in USDC
 * @param creatorWallet - Creator's wallet for revenue split
 * @param signedAuthorization - User's signed TransferWithAuthorization
 */
export async function executeLessonPurchase(
  userWallet: string,
  lessonId: string,
  resourceUrl: string,
  amountUsdc: string,
  creatorWallet: string,
  signedAuthorization: Record<string, unknown>
): Promise<RunnerX402PayResult> {
  // Validate inputs
  if (!userWallet.startsWith("0x") || userWallet.length !== 42) {
    throw new RunnerError("Invalid user wallet address", 400);
  }
  if (!creatorWallet.startsWith("0x") || creatorWallet.length !== 42) {
    throw new RunnerError("Invalid creator wallet address", 400);
  }
  if (!lessonId || !resourceUrl) {
    throw new RunnerError("Missing lessonId or resourceUrl", 400);
  }

  const available = await isRunnerAvailable();
  if (!available) {
    throw new RunnerError("ArcLayer Runner is not available", 503);
  }

  const result = await runnerX402PayLesson({
    userWallet,
    lessonId,
    resourceUrl,
    amountUsdc,
    creatorWallet,
    paymentChallenge: {},
    signedAuthorization,
  });

  if (!result.ok) {
    throw new RunnerError(
      `Payment failed: ${result.error || "Unknown error"}`,
      402
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
