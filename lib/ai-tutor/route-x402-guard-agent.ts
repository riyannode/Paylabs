/**
 * Route x402 Guard Agent Node
 *
 * LangGraph node that charges a tiny x402 route toll before the proposal
 * graph is allowed to run. Payment execution goes through ArcLayer Runner only.
 *
 * Hard rules:
 * - No local private keys
 * - No fake payment IDs
 * - No fake tx hashes
 * - No DB-only paid access
 * - No direct Circle calls
 * - No direct wallet API calls
 * - No contract calls from LangGraph or LLM
 * - All route toll payment execution must go through ArcLayer Runner
 * - If route toll payment proof is incomplete, block
 * - If route toll payment fails, block
 */

import { createHash } from "node:crypto";
import type { TutorIntakeStateType } from "./intake-state";
import { executeRouteTollPayment } from "@/lib/arclayer-runner/route-toll";

// ─── Route toll amounts from env ─────────────────────────────────

const ROUTE_TOLL_DEFAULTS: Record<string, string> = {
  normal: "0.000001",
  advanced: "0.000002",
  premium: "0.000003",
};

function getRouteTollAmount(tier: string): string {
  switch (tier) {
    case "normal":
      return process.env.PAYLABS_ROUTE_TOLL_NORMAL_USDC || ROUTE_TOLL_DEFAULTS.normal;
    case "advanced":
      return process.env.PAYLABS_ROUTE_TOLL_ADVANCED_USDC || ROUTE_TOLL_DEFAULTS.advanced;
    case "premium":
      return process.env.PAYLABS_ROUTE_TOLL_PREMIUM_USDC || ROUTE_TOLL_DEFAULTS.premium;
    default:
      return ROUTE_TOLL_DEFAULTS.normal;
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Main agent node ────────────────────────────────────────────

export async function routeX402GuardAgent(
  state: TutorIntakeStateType
): Promise<Partial<TutorIntakeStateType>> {
  const {
    userMessage,
    wallet,
    normalizedGoal,
    recommendedRouteTier,
    routeLabel,
    needsClarification,
  } = state;

  // Check if route toll is enabled
  const tollEnabled = process.env.PAYLABS_ROUTE_TOLL_ENABLED === "true";
  if (!tollEnabled) {
    return {
      routeTollEnabled: false,
      routeTollRequired: false,
      routePaymentStatus: "skipped",
    };
  }

  // If clarification is needed, do NOT charge toll
  if (needsClarification) {
    return {
      routeTollEnabled: true,
      routeTollRequired: false,
      routePaymentStatus: "skipped_clarification",
    };
  }

  // Need a recommended route tier to charge toll
  if (!recommendedRouteTier) {
    return {
      routeTollEnabled: true,
      routeTollRequired: false,
      routePaymentStatus: "skipped_no_route",
    };
  }

  // Validate wallet
  if (!wallet || !wallet.startsWith("0x") || wallet.length !== 42) {
    return {
      routeTollEnabled: true,
      routeTollRequired: true,
      routePaymentStatus: "blocked",
      routePaymentError: "Valid wallet address required for route toll payment",
      error: "Wallet required for route toll payment",
    };
  }

  // Validate route toll wallet
  const routeTollWallet = process.env.PAYLABS_ROUTE_TOLL_WALLET;
  if (
    !routeTollWallet ||
    !routeTollWallet.startsWith("0x") ||
    routeTollWallet.length !== 42
  ) {
    return {
      routeTollEnabled: true,
      routeTollRequired: true,
      routePaymentStatus: "blocked",
      routePaymentError:
        "PAYLABS_ROUTE_TOLL_WALLET not configured or invalid",
      error: "Route toll wallet not configured",
    };
  }
  if (routeTollWallet.toLowerCase() === ZERO_ADDRESS) {
    return {
      routeTollEnabled: true,
      routeTollRequired: true,
      routePaymentStatus: "blocked",
      routePaymentError: "PAYLABS_ROUTE_TOLL_WALLET is zero address",
      error: "Route toll wallet is zero address",
    };
  }

  // Compute toll amount
  const amountUsdc = getRouteTollAmount(recommendedRouteTier);
  const amountNum = Number(amountUsdc);

  // Compute deterministic input hash for audit trail
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        userMessage: userMessage || "",
        normalizedGoal: normalizedGoal || "",
        recommendedRouteTier,
        amountUsdc,
        userWallet: wallet,
      })
    )
    .digest("hex");

  // Execute route toll payment via Runner
  const result = await executeRouteTollPayment({
    userWallet: wallet,
    routeTier: recommendedRouteTier,
    routeLabel: routeLabel || "Easy Path",
    amountUsdc,
    routeTollWallet,
    inputHash,
  });

  if (!result.ok) {
    return {
      routeTollEnabled: true,
      routeTollRequired: true,
      routeTollAmountUsdc: amountNum,
      routeTollWallet,
      routePaymentStatus: "failed",
      routePaymentError: result.error || "Route toll payment failed",
      routeInputHash: inputHash,
      error: `Route toll payment failed: ${result.error}`,
    };
  }

  // Payment succeeded — return proof
  return {
    routeTollEnabled: true,
    routeTollRequired: true,
    routeTollAmountUsdc: amountNum,
    routeTollWallet,
    routePaymentId: result.paymentId,
    routePaymentRef: result.paymentRef,
    routeSettlementRef: result.settlementRef,
    routePaymentStatus: "completed",
    routeInputHash: inputHash,
  };
}
