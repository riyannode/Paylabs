/**
 * Withdrawal Validation
 *
 * Amount validation, fee cap checks, and ownership verification.
 */

import { usdcDecimalToAtomic } from "../x402/usdc";
import { MAX_WITHDRAWAL_FEE_ATOMIC } from "./gateway-types";

// ─── Amount Validation ───────────────────────────────────────

export interface ValidateAmountInput {
  /** Human-readable USDC amount (e.g., "0.100000") */
  amountUsdc: string;
  /** Available balance in atomic units (from Gateway balance check) */
  availableAtomic: string;
}

export interface ValidateAmountResult {
  ok: boolean;
  amountAtomic?: string;
  error?: string;
}

/**
 * Validate a withdrawal amount against available balance.
 * Returns the atomic amount if valid.
 */
export function validateAmount(input: ValidateAmountInput): ValidateAmountResult {
  const { amountUsdc, availableAtomic } = input;

  // Parse amount
  if (!amountUsdc || typeof amountUsdc !== "string") {
    return { ok: false, error: "amount is required" };
  }

  const trimmed = amountUsdc.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    return { ok: false, error: "Invalid amount format" };
  }

  const amountAtomic = usdcDecimalToAtomic(trimmed);
  if (amountAtomic <= BigInt(0)) {
    return { ok: false, error: "Amount must be greater than zero" };
  }

  // Check against available balance
  const available = BigInt(availableAtomic || "0");
  if (amountAtomic > available) {
    return {
      ok: false,
      error: `Amount exceeds available balance: requested ${trimmed} USDC, available ${(Number(available) / 1_000_000).toFixed(6)} USDC`,
    };
  }

  return { ok: true, amountAtomic: amountAtomic.toString() };
}

// ─── Fee Cap Validation ──────────────────────────────────────

export interface ValidateFeeCapInput {
  /** Gateway-estimated fee in atomic units */
  estimatedFee: string;
}

export interface ValidateFeeCapResult {
  ok: boolean;
  error?: string;
}

/**
 * Check if the Gateway-estimated fee exceeds the application fee cap.
 * The fee cap is a REJECTION threshold — it does NOT replace the fee.
 */
export function validateFeeCap(input: ValidateFeeCapInput): ValidateFeeCapResult {
  const estimated = BigInt(input.estimatedFee || "0");
  const cap = BigInt(MAX_WITHDRAWAL_FEE_ATOMIC);

  if (estimated > cap) {
    return {
      ok: false,
      error: `Gateway fee exceeds application cap: estimated ${estimated.toString()} atomic, cap ${cap.toString()} atomic`,
    };
  }

  return { ok: true };
}

// ─── Ownership Validation ────────────────────────────────────

export interface ValidateOwnershipInput {
  /** Expected owner reference (session.sub for DCW, walletId for UCW) */
  expectedOwnerRef: string;
  /** Actual owner reference from DB row */
  actualOwnerRef: string;
  /** Expected wallet address */
  expectedAddress: string;
  /** Actual wallet address from DB row */
  actualAddress: string;
}

/**
 * Verify that a withdrawal row belongs to the authenticated session.
 */
export function validateOwnership(input: ValidateOwnershipInput): boolean {
  return (
    input.expectedOwnerRef === input.actualOwnerRef &&
    input.expectedAddress.toLowerCase() === input.actualAddress.toLowerCase()
  );
}
