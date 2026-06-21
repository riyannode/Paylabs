import type { ServiceName } from "./agent-services/types";

/**
 * Payment Feature Flags
 *
 * All payment-moving flags default false.
 * Code checks these before any real fund movement.
 * Skeleton/audit logic runs regardless of flags.
 *
 * Agent allowlist:
 *   PAYLABS_X402_ENABLED_AGENT_NAMES — comma-separated list of agent names
 *   that are allowed to run real x402 payment. Default: empty (none).
 *   Even when PAYLABS_AGENT_NANOPAYMENTS_ENABLED=true, only agents in this
 *   list will attempt real x402. All others remain audit-only.
 *
 * Delegated runtime:
 *   PAYLABS_DELEGATED_RUNTIME_ENABLED — enable the delegated agentic runtime.
 *   Default: false (existing flow unchanged).
 *   PAYLABS_X402_ENABLED_SERVICE_NAMES — comma-separated service names
 *   for delegated service x402 payment. Default: empty (none).
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

// ─── Agent x402 Allowlist ──────────────────────────────────────

/**
 * Parse the x402 agent allowlist from env.
 * PAYLABS_X402_ENABLED_AGENT_NAMES — comma-separated agent names.
 * Default: empty array (no agents enabled for real x402).
 *
 * Example: PAYLABS_X402_ENABLED_AGENT_NAMES=tutor_intake
 * Example: PAYLABS_X402_ENABLED_AGENT_NAMES=tutor_intake,intent_classifier
 */
export function getX402EnabledAgents(): string[] {
  const raw = (process.env.PAYLABS_X402_ENABLED_AGENT_NAMES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check if a specific agent is enabled for real x402 payment.
 *
 * Both conditions must be true:
 *   1. PAYLABS_AGENT_NANOPAYMENTS_ENABLED === "true" (main gate)
 *   2. agentName is in PAYLABS_X402_ENABLED_AGENT_NAMES (allowlist)
 *
 * If allowlist is empty, no agents run real x402 (safe default).
 */
export function isX402EnabledForAgent(agentName: string): boolean {
  const flags = getPaymentFlags();
  if (!flags.agentNanopaymentsEnabled) return false;
  const enabledAgents = getX402EnabledAgents();
  if (enabledAgents.length === 0) return false;
  return enabledAgents.includes(agentName.toLowerCase());
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

// ─── Delegated Runtime Flags ────────────────────────────────────

/**
 * Check if the delegated agentic runtime is enabled.
 * Default: false (existing flow unchanged).
 */
export function isDelegatedRuntimeEnabled(): boolean {
  return process.env.PAYLABS_DELEGATED_RUNTIME_ENABLED === "true";
}

/**
 * Parse the x402 service allowlist from env.
 * PAYLABS_X402_ENABLED_SERVICE_NAMES — comma-separated service names.
 * Default: empty array (no services enabled for real x402).
 *
 * Example: PAYLABS_X402_ENABLED_SERVICE_NAMES=intent_planner
 * Example: PAYLABS_X402_ENABLED_SERVICE_NAMES=intent_planner,query_builder
 */
export function getX402EnabledServices(): string[] {
  const raw = (process.env.PAYLABS_X402_ENABLED_SERVICE_NAMES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check if a specific delegated service is enabled for real x402 payment.
 *
 * Both conditions must be true:
 *   1. PAYLABS_DELEGATED_RUNTIME_ENABLED === "true" (main gate)
 *   2. serviceName is in PAYLABS_X402_ENABLED_SERVICE_NAMES (allowlist)
 *
 * If allowlist is empty, no services run real x402 (safe default).
 */
export function isX402EnabledForService(serviceName: ServiceName): boolean {
  if (!isDelegatedRuntimeEnabled()) return false;
  const enabledServices = getX402EnabledServices();
  if (enabledServices.length === 0) return false;
  return enabledServices.includes(serviceName.toLowerCase());
}
