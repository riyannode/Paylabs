/**
 * ArcLayer Runner — Route Toll Payment
 *
 * Executes a tiny x402 route toll through Runner before the proposal graph runs.
 * This is the ONLY path for route toll payments.
 *
 * Never uses local private keys.
 * Never generates fallback payment IDs.
 * Never calls Circle directly.
 * Returns structured result — caller must validate proof completeness.
 */

import { runnerFetch } from "./client";

export interface RouteTollInput {
  userWallet: string;
  routeTier: string;
  routeLabel: string;
  amountUsdc: string;
  routeTollWallet: string;
  inputHash: string;
}

export interface RouteTollResult {
  ok: boolean;
  paymentId?: string;
  paymentRef?: string;
  settlementRef?: string;
  txHash?: string;
  error?: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Execute route toll payment through ArcLayer Runner.
 * This is the ONLY path for route toll payments.
 *
 * Never uses local private keys.
 * Never generates fallback payment IDs.
 * Returns structured result — caller must validate proof completeness.
 */
export async function executeRouteTollPayment(
  input: RouteTollInput
): Promise<RouteTollResult> {
  // Validate user wallet
  if (!input.userWallet.startsWith("0x") || input.userWallet.length !== 42) {
    return { ok: false, error: "Invalid user wallet address" };
  }

  // Validate route toll wallet
  if (
    !input.routeTollWallet.startsWith("0x") ||
    input.routeTollWallet.length !== 42
  ) {
    return { ok: false, error: "Invalid route toll wallet address" };
  }

  // Block zero address
  if (input.routeTollWallet.toLowerCase() === ZERO_ADDRESS) {
    return {
      ok: false,
      error: "Route toll wallet is zero address — payment blocked",
    };
  }

  // Validate amount
  if (!input.amountUsdc || Number(input.amountUsdc) <= 0) {
    return { ok: false, error: "Invalid route toll amount" };
  }

  // Validate route tier
  if (!["normal", "advanced", "premium"].includes(input.routeTier)) {
    return { ok: false, error: `Invalid route tier: ${input.routeTier}` };
  }

  // Deterministic idempotency key
  const idempotencyKey = `route-toll:${input.userWallet}:${input.routeTier}:${input.inputHash}:${input.amountUsdc}`;

  try {
    const result = await runnerFetch<RouteTollResult>("POST", "/x402/pay", {
      type: "route_toll_pay",
      routeTier: input.routeTier,
      routeLabel: input.routeLabel,
      amountUsdc: input.amountUsdc,
      userWallet: input.userWallet,
      routeTollWallet: input.routeTollWallet,
      inputHash: input.inputHash,
      idempotencyKey,
    });

    // Validate proof completeness
    if (!result.ok) {
      return { ok: false, error: result.error || "Route toll payment failed" };
    }
    if (!result.paymentId) {
      return {
        ok: false,
        error: "Runner returned no paymentId — proof incomplete",
      };
    }
    if (!result.paymentRef && !result.settlementRef) {
      return {
        ok: false,
        error:
          "Runner returned no paymentRef or settlementRef — proof incomplete",
      };
    }

    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
