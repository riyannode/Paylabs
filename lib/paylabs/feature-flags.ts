import type { ServiceName } from "./agent-services/types";

// ─── Delegated Runtime Flags ────────────────────────────────────

/**
 * All services eligible for x402 payment.
 */
const ALL_X402_SERVICES: readonly string[] = [
  "intent_planner",
  "query_builder",
  "signal_scout",
  "signal_scout_basics",
  "intent_matcher",
  "source_verifier",
  "value_allocator",
  "trust_verifier",
  "payment_decider",
  "payment_router",
];

/**
 * Check if the delegated agentic runtime is enabled.
 * Default: false (existing flow unchanged).
 */
export function isDelegatedRuntimeEnabled(): boolean {
  return process.env.PAYLABS_DELEGATED_RUNTIME_ENABLED === "true";
}

/**
 * Parse the x402 service allowlist from env.
 * PAYLABS_X402_ENABLED_SERVICE_NAMES — comma-separated service names, or "all"/"*".
 * Default: empty array (no services enabled for real x402).
 *
 * Example: PAYLABS_X402_ENABLED_SERVICE_NAMES=intent_planner
 * Example: PAYLABS_X402_ENABLED_SERVICE_NAMES=intent_planner,query_builder
 * Example: PAYLABS_X402_ENABLED_SERVICE_NAMES=all
 */
export function getX402EnabledServices(): string[] {
  const raw = (process.env.PAYLABS_X402_ENABLED_SERVICE_NAMES || "").trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all" || raw === "*") return [...ALL_X402_SERVICES];
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

// ─── Delegated Inline Execution Flags ──────────────────────

/**
 * Check if Vercel inline delegated execution is enabled.
 * When true, API routes can run the orchestrator directly
 * without the VPS worker / background runner.
 * Default: false
 */
export function isDelegatedInlineExecutionEnabled(): boolean {
  return process.env.PAYLABS_DELEGATED_INLINE_EXECUTION === "true";
}

export {
  getAgentServiceExecutionMode,
  isAgentServiceLlmEnabled,
} from "./agent-services/execution-mode";
