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
  "creator_attribution",
  "advanced_evidence_evaluator",
  "creator_payout_router",
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

// ─── Auto-Tier Preflight Flag ───────────────────────────────

/**
 * Check if auto-tier route preflight is enabled.
 * When true, route_tier=auto uses a two-step flow:
 *   1. Route-only preflight (0.000001 USDC) → Brain selects tier
 *   2. Final entry payment (locked quote - routing fee) → full orchestration
 *
 * When false (default), existing production flow is unchanged:
 *   auto → easy quote → entry payment → Brain resolves tier → orchestration.
 */
export function isAutoTierPreflightEnabled(): boolean {
  return process.env.PAYLABS_AUTO_TIER_PREFLIGHT_ENABLED === "true";
}

export {
  getAgentServiceExecutionMode,
  isAgentServiceLlmEnabled,
} from "./agent-services/execution-mode";
