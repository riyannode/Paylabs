/**
 * PayLabs x402 Payment Scheme Routing (Circle-only)
 *
 * All payment edges use Circle GatewayWalletBatched x402.
 * No non-Circle x402 settlement implementations.
 *
 * Payment model:
 *   controller/user → Brain         = circle_gateway_wallet_batched (treasury 0.000003)
 *   Brain → macro-node              = circle_gateway_wallet_batched (macro allocation)
 *   macro-node → child services     = per-child circle_gateway_wallet_batched (fallback)
 *                                     or grouped child (if Circle SDK supports it)
 */

// ─── Circle Payment Modes ───────────────────────────────────

export type CircleX402PaymentMode =
  | "circle_gateway_wallet_batched"
  | "circle_gateway_wallet_batched_grouped_child"
  | "circle_gateway_wallet_batched_per_child_fallback";

// ─── Payment Layers ─────────────────────────────────────────

export type PayLabsPaymentLayer =
  | "controller_to_brain"
  | "brain_to_macro"
  | "macro_to_child";

// ─── Scheme Resolution ──────────────────────────────────────

export interface PaymentSchemeParams {
  layer: PayLabsPaymentLayer;
  childServiceCount: number;
  macroNodeName: string;
}

/**
 * Resolve which Circle x402 payment mode to use for a payment edge.
 *
 * Rules:
 * - controller_to_brain = circle_gateway_wallet_batched
 * - brain_to_macro = circle_gateway_wallet_batched
 * - macro_to_child = grouped child if Circle SDK supports it cleanly,
 *                    otherwise per-child fallback
 */
export function resolvePaymentSchemeForEdge(
  params: PaymentSchemeParams
): { mode: CircleX402PaymentMode; reason: string } {
  const { layer, childServiceCount, macroNodeName } = params;

  // controller → Brain and Brain → macro always use GatewayWalletBatched
  if (layer === "controller_to_brain" || layer === "brain_to_macro") {
    return {
      mode: "circle_gateway_wallet_batched",
      reason: `${layer} always uses circle_gateway_wallet_batched`,
    };
  }

  // macro → child: use grouped child if enabled, else per-child fallback
  if (isGroupedChildPaymentEnabled() && childServiceCount > 1) {
    return {
      mode: "circle_gateway_wallet_batched_grouped_child",
      reason: `${macroNodeName} has ${childServiceCount} children — grouped Circle child payment`,
    };
  }

  // Per-child fallback (always acceptable)
  return {
    mode: "circle_gateway_wallet_batched_per_child_fallback",
    reason: `${macroNodeName} has ${childServiceCount} child(ren) — per-child Circle x402 fallback`,
  };
}

// ─── Feature Flag Helpers ───────────────────────────────────

/**
 * Check if grouped Circle child payment is enabled.
 * Default: false (per-child fallback is safe and always works).
 */
export function isGroupedChildPaymentEnabled(): boolean {
  return process.env.PAYLABS_X402_GROUPED_CHILD_ENABLED === "true";
}
