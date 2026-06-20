/**
 * Payment Feature Flags
 *
 * All payment-moving flags default false.
 * Code checks these before any real fund movement.
 * Skeleton/audit logic runs regardless of flags.
 */

export interface PaymentFlags {
  /** Main payment route: "circle_gateway_x402" or "none" */
  paymentRoute: string;
  /** Payment executor: "circle_sdk" or "noop" */
  paymentExecutor: string;
  /** Discovery fee payment enabled */
  discoveryFeeEnabled: boolean;
  /** Agent nanopayments enabled */
  agentNanopaymentsEnabled: boolean;
  /** Agent batch settlement enabled */
  agentBatchSettlementEnabled: boolean;
  /** Agent wallet float enabled */
  agentWalletFloatEnabled: boolean;
}

/**
 * Read current payment flags from env.
 * All boolean flags default false.
 */
export function getPaymentFlags(): PaymentFlags {
  return {
    paymentRoute: (process.env.PAYLABS_PAYMENT_ROUTE || "none").toLowerCase(),
    paymentExecutor: (process.env.PAYLABS_PAYMENT_EXECUTOR || "noop").toLowerCase(),
    discoveryFeeEnabled: process.env.PAYLABS_X402_DISCOVERY_FEE_ENABLED === "true",
    agentNanopaymentsEnabled: process.env.PAYLABS_AGENT_NANOPAYMENTS_ENABLED === "true",
    agentBatchSettlementEnabled: process.env.PAYLABS_AGENT_BATCH_SETTLEMENT_ENABLED === "true",
    agentWalletFloatEnabled: process.env.PAYLABS_AGENT_WALLET_FLOAT_ENABLED === "true",
  };
}

/**
 * Check if ANY real payment movement is enabled.
 */
export function isAnyPaymentEnabled(): boolean {
  const flags = getPaymentFlags();
  return (
    flags.discoveryFeeEnabled ||
    flags.agentNanopaymentsEnabled ||
    flags.agentBatchSettlementEnabled
  );
}

/**
 * Check if real Circle Gateway settlement is configured.
 * Requires payment route + executor + at least one flag.
 */
export function isGatewaySettlementConfigured(): boolean {
  const flags = getPaymentFlags();
  return (
    flags.paymentRoute === "circle_gateway_x402" &&
    flags.paymentExecutor === "circle_sdk" &&
    isAnyPaymentEnabled()
  );
}
