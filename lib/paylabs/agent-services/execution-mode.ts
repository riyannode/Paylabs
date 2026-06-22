/**
 * Agent Service Execution Mode
 *
 * Controls how the 9 delegated agent services execute:
 *   - deterministic: no LLM, DB/rules/math/schema checks only (DEFAULT)
 *   - llm: service handler may call LLM (structured JSON, no CoT)
 *   - hybrid: deterministic decision first, LLM for summary/explanation only
 *
 * The Brain (orchestrator) is ALWAYS LLM-assisted. This switch applies
 * to the 9 delegated agent services only.
 *
 * Per-service env override global fallback:
 *   PAYLABS_AGENT_SERVICE_EXECUTION_MODE_<SERVICE_KEY> overrides PAYLABS_AGENT_SERVICE_EXECUTION_MODE
 *   PAYLABS_AGENT_SERVICE_LLM_ENABLED_<SERVICE_KEY> overrides PAYLABS_AGENT_SERVICE_LLM_ENABLED
 *
 * Hard locks:
 *   - payment_decider → always deterministic (regardless of env)
 *   - payment_router → always deterministic (regardless of env)
 */

import type { ServiceName } from "./types";

// ─── Service Execution Mode ──────────────────────────────────

export type AgentServiceExecutionMode = "deterministic" | "llm" | "hybrid";

const VALID_MODES: AgentServiceExecutionMode[] = ["deterministic", "llm", "hybrid"];
const DEFAULT_MODE: AgentServiceExecutionMode = "deterministic";

// ─── Hard-locked services (always deterministic) ────────────

const HARD_LOCKED_DETERMINISTIC: Set<string> = new Set([
  "payment_decider",
  "payment_router",
]);

// ─── LLM-capable services ───────────────────────────────────

const LLM_CAPABLE_SERVICES: Set<string> = new Set([
  "intent_planner",
  "query_builder",
  "signal_scout",
  "intent_matcher",
  "source_verifier",
  "value_allocator",
  "trust_verifier",
]);

// ─── Service name → env key mapping ─────────────────────────

const SERVICE_ENV_KEY_MAP: Record<string, string> = {
  intent_planner: "INTENT_PLANNER",
  query_builder: "QUERY_BUILDER",
  signal_scout: "SIGNAL_SCOUT",
  intent_matcher: "INTENT_MATCHER",
  source_verifier: "SOURCE_VERIFIER",
  value_allocator: "VALUE_ALLOCATOR",
  trust_verifier: "TRUST_VERIFIER",
  payment_decider: "PAYMENT_DECIDER",
  payment_router: "PAYMENT_ROUTER",
};

// ─── Helpers ─────────────────────────────────────────────────

function getServiceEnvKey(serviceName: string): string {
  return SERVICE_ENV_KEY_MAP[serviceName] || serviceName.toUpperCase();
}

/**
 * Check if a service is LLM-capable.
 * LLM-capable services can run in hybrid or llm mode.
 * Non-LLM services always run deterministic.
 */
export function isServiceLlmCapable(serviceName: string): boolean {
  return LLM_CAPABLE_SERVICES.has(serviceName);
}

// ─── Per-Service Mode Resolution ─────────────────────────────

/**
 * Get the execution mode for a specific service.
 * Resolution: per-service env → DEFAULT env → global env → hardcoded default.
 */
function getServiceMode(serviceName: string): AgentServiceExecutionMode {
  // Hard lock: always deterministic
  if (HARD_LOCKED_DETERMINISTIC.has(serviceName)) {
    return "deterministic";
  }

  const envKey = getServiceEnvKey(serviceName);

  // Per-service env: PAYLABS_AGENT_SERVICE_EXECUTION_MODE_<SERVICE_KEY>
  const perService = (process.env[`PAYLABS_AGENT_SERVICE_EXECUTION_MODE_${envKey}`] || "").toLowerCase();
  if (perService && VALID_MODES.includes(perService as AgentServiceExecutionMode)) {
    return perService as AgentServiceExecutionMode;
  }

  // DEFAULT env: PAYLABS_AGENT_SERVICE_EXECUTION_MODE_DEFAULT
  const defaultEnv = (process.env.PAYLABS_AGENT_SERVICE_EXECUTION_MODE_DEFAULT || "").toLowerCase();
  if (defaultEnv && VALID_MODES.includes(defaultEnv as AgentServiceExecutionMode)) {
    return defaultEnv as AgentServiceExecutionMode;
  }

  // Global env (backward compat): PAYLABS_AGENT_SERVICE_EXECUTION_MODE
  const globalEnv = (process.env.PAYLABS_AGENT_SERVICE_EXECUTION_MODE || DEFAULT_MODE).toLowerCase();
  return VALID_MODES.includes(globalEnv as AgentServiceExecutionMode)
    ? (globalEnv as AgentServiceExecutionMode)
    : DEFAULT_MODE;
}

/**
 * Check if LLM is enabled for a specific service.
 * Resolution: per-service env → DEFAULT env → global env → false.
 */
function getServiceLlmEnabled(serviceName: string): boolean {
  // Hard lock: always disabled
  if (HARD_LOCKED_DETERMINISTIC.has(serviceName)) {
    return false;
  }

  const envKey = getServiceEnvKey(serviceName);

  // Per-service env: PAYLABS_AGENT_SERVICE_LLM_ENABLED_<SERVICE_KEY>
  const perService = process.env[`PAYLABS_AGENT_SERVICE_LLM_ENABLED_${envKey}`];
  if (perService !== undefined) {
    return perService === "true";
  }

  // DEFAULT env: PAYLABS_AGENT_SERVICE_LLM_ENABLED_DEFAULT
  const defaultEnv = process.env.PAYLABS_AGENT_SERVICE_LLM_ENABLED_DEFAULT;
  if (defaultEnv !== undefined) {
    return defaultEnv === "true";
  }

  // Global env (backward compat): PAYLABS_AGENT_SERVICE_LLM_ENABLED
  return process.env.PAYLABS_AGENT_SERVICE_LLM_ENABLED === "true";
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get the global agent service execution mode from env.
 * Default: "deterministic"
 *
 * @deprecated Use shouldRunServiceAsDeterministic(serviceName) for per-service resolution.
 */
export function getAgentServiceExecutionMode(): AgentServiceExecutionMode {
  return getServiceMode("default");
}

/**
 * Check if service-level LLM calls are enabled.
 * Default: false
 *
 * @deprecated Use shouldRunServiceAsDeterministic(serviceName) for per-service resolution.
 */
export function isAgentServiceLlmEnabled(): boolean {
  return getServiceLlmEnabled("default");
}

/**
 * Should this service run in deterministic mode?
 * True when:
 *   - service is hard-locked (payment_decider, payment_router), OR
 *   - service mode is "deterministic", OR
 *   - service LLM is disabled, OR
 *   - service is not LLM-capable
 */
export function shouldRunServiceAsDeterministic(serviceName: string): boolean {
  if (HARD_LOCKED_DETERMINISTIC.has(serviceName)) return true;
  if (!isServiceLlmCapable(serviceName)) return true;
  const mode = getServiceMode(serviceName);
  if (mode === "deterministic") return true;
  return !getServiceLlmEnabled(serviceName);
}

/**
 * Should this service run in hybrid mode?
 * True only when:
 *   - service mode is "hybrid"
 *   - service LLM is enabled
 *   - service is LLM-capable
 */
export function shouldRunServiceAsHybrid(serviceName: string): boolean {
  if (HARD_LOCKED_DETERMINISTIC.has(serviceName)) return false;
  if (!isServiceLlmCapable(serviceName)) return false;
  const mode = getServiceMode(serviceName);
  return mode === "hybrid" && getServiceLlmEnabled(serviceName);
}

/**
 * Should this service run in LLM mode?
 * True only when:
 *   - service mode is "llm"
 *   - service LLM is enabled
 *   - service is LLM-capable
 */
export function shouldRunServiceAsLlm(serviceName: string): boolean {
  if (HARD_LOCKED_DETERMINISTIC.has(serviceName)) return false;
  if (!isServiceLlmCapable(serviceName)) return false;
  const mode = getServiceMode(serviceName);
  return mode === "llm" && getServiceLlmEnabled(serviceName);
}

// ─── Safe Diagnostics ───────────────────────────────────────

const ALL_SERVICES: ServiceName[] = [
  "intent_planner",
  "query_builder",
  "signal_scout",
  "intent_matcher",
  "source_verifier",
  "value_allocator",
  "trust_verifier",
  "payment_decider",
  "payment_router",
];

/**
 * Get execution mode summary for all services.
 * Safe for diagnostics — no secrets.
 */
export function getServiceExecutionModeSummary(): Array<{
  serviceName: string;
  mode: AgentServiceExecutionMode;
  llmEnabled: boolean;
  llmCapable: boolean;
  hardLocked: boolean;
}> {
  return ALL_SERVICES.map((name) => ({
    serviceName: name,
    mode: getServiceMode(name),
    llmEnabled: getServiceLlmEnabled(name),
    llmCapable: isServiceLlmCapable(name),
    hardLocked: HARD_LOCKED_DETERMINISTIC.has(name),
  }));
}
