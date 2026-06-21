/**
 * PayLabs x402 Payment Scheme Routing
 *
 * Explicit scheme types for tiered x402 payment architecture:
 * - Brain → macro = exact_nano (fixed-price x402 per request, small amount)
 * - Macro → many child = batch_child (batch settlement, when implemented)
 * - Macro → one child = exact_nano (fixed-price x402)
 *
 * Current repo uses GatewayWalletBatched (Circle's exact x402 with batched
 * on-chain settlement). This is NOT true batch settlement (no channel/voucher
 * storage, no claim/settle manager).
 *
 * Rules:
 * - exact_nano and batch_child are INTERNAL implementation details only.
 * - Do NOT expose as user-selectable settlement modes.
 * - Default flags = false → preserves current PR #22 behavior.
 */

// ─── Scheme Types ───────────────────────────────────────────

export type PayLabsX402Scheme =
  | "exact_nano"
  | "batch_child";

export type PayLabsPaymentLayer =
  | "brain_to_macro"
  | "macro_to_child";

// ─── Scheme Resolution ──────────────────────────────────────

export interface PaymentSchemeParams {
  layer: PayLabsPaymentLayer;
  childServiceCount: number;
  macroNodeName: string;
}

/**
 * Resolve which x402 scheme to use for a payment edge.
 *
 * Rules:
 * - brain_to_macro always uses exact_nano
 * - macro_to_child with >1 child uses batch_child (when enabled)
 * - macro_to_child with 1 child uses exact_nano
 *
 * If batch_child is disabled and macro has >1 children:
 * - fail closed if x402 child payment is required
 * - otherwise fall back to exact_nano (one-at-a-time)
 */
export function resolvePaymentSchemeForEdge(
  params: PaymentSchemeParams
): { scheme: PayLabsX402Scheme; reason: string } {
  const { layer, childServiceCount, macroNodeName } = params;

  // Brain → macro is always exact_nano
  if (layer === "brain_to_macro") {
    return { scheme: "exact_nano", reason: "brain_to_macro always uses exact_nano" };
  }

  // Macro → one child: exact_nano
  if (childServiceCount <= 1) {
    return {
      scheme: "exact_nano",
      reason: `${macroNodeName} has ${childServiceCount} child(ren) — exact_nano`,
    };
  }

  // Macro → many children: batch_child if enabled, else exact_nano fallback
  if (isBatchChildSchemeEnabled()) {
    return {
      scheme: "batch_child",
      reason: `${macroNodeName} has ${childServiceCount} children — batch_child enabled`,
    };
  }

  // batch_child disabled — fall back to exact_nano (one-at-a-time)
  return {
    scheme: "exact_nano",
    reason: `${macroNodeName} has ${childServiceCount} children but batch_child disabled — exact_nano fallback`,
  };
}

// ─── Feature Flag Helpers ───────────────────────────────────

/**
 * Check if exact_nano scheme is enabled.
 * Default: false (preserves current PR #22 behavior).
 */
export function isExactNanoSchemeEnabled(): boolean {
  return process.env.PAYLABS_X402_EXACT_NANO_ENABLED === "true";
}

/**
 * Check if batch_child scheme is enabled.
 * Default: false (no real batch settlement implemented yet).
 *
 * WARNING: Current repo does NOT implement official x402 batch-settlement
 * (no channel/voucher storage, no claim/settle manager). Do NOT enable
 * this flag in production until those are implemented.
 */
export function isBatchChildSchemeEnabled(): boolean {
  return process.env.PAYLABS_X402_CHILD_BATCH_ENABLED === "true";
}

/**
 * Check if the official x402 batch-settlement scheme should be used
 * (vs the current GatewayWalletBatched exact-like flow).
 * Default: false.
 */
export function isOfficialBatchSchemeEnabled(): boolean {
  return process.env.PAYLABS_X402_CHILD_BATCH_USE_OFFICIAL_SCHEME === "true";
}

/**
 * Check if tiered bundle payment routing is enabled.
 * When false, current PR #22 flat x402 behavior is preserved.
 * Default: false.
 */
export function isTieredBundlePaymentsEnabled(): boolean {
  return process.env.PAYLABS_TIERED_BUNDLE_PAYMENTS_ENABLED === "true";
}
