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
 * Env:
 *   PAYLABS_AGENT_SERVICE_EXECUTION_MODE = deterministic | llm | hybrid
 *   PAYLABS_AGENT_SERVICE_LLM_ENABLED   = true | false
 *
 * Default: deterministic, LLM disabled.
 */

import type { ServiceName } from "./types";

// ─── Service Execution Mode ──────────────────────────────────

export type AgentServiceExecutionMode = "deterministic" | "llm" | "hybrid";

const VALID_MODES: AgentServiceExecutionMode[] = ["deterministic", "llm", "hybrid"];
const DEFAULT_MODE: AgentServiceExecutionMode = "deterministic";

/**
 * Get the global agent service execution mode from env.
 * Default: "deterministic"
 */
export function getAgentServiceExecutionMode(): AgentServiceExecutionMode {
  const raw = (process.env.PAYLABS_AGENT_SERVICE_EXECUTION_MODE || DEFAULT_MODE).toLowerCase();
  return VALID_MODES.includes(raw as AgentServiceExecutionMode)
    ? (raw as AgentServiceExecutionMode)
    : DEFAULT_MODE;
}

/**
 * Check if service-level LLM calls are enabled.
 * Default: false
 */
export function isAgentServiceLlmEnabled(): boolean {
  return process.env.PAYLABS_AGENT_SERVICE_LLM_ENABLED === "true";
}

/**
 * Should this service run in deterministic mode?
 * True when global mode is "deterministic" OR when LLM is disabled.
 */
export function shouldRunServiceAsDeterministic(serviceName: ServiceName): boolean {
  void serviceName; // per-service overrides may come later
  const mode = getAgentServiceExecutionMode();
  if (mode === "deterministic") return true;
  return !isAgentServiceLlmEnabled();
}

/**
 * Should this service run in LLM mode?
 * True when global mode is "llm" AND LLM is enabled.
 */
export function shouldRunServiceAsLlm(serviceName: ServiceName): boolean {
  void serviceName;
  const mode = getAgentServiceExecutionMode();
  return mode === "llm" && isAgentServiceLlmEnabled();
}

/**
 * Should this service run in hybrid mode?
 * True when global mode is "hybrid" AND LLM is enabled.
 * Hybrid = deterministic decision + LLM explanation/summary.
 */
export function shouldRunServiceAsHybrid(serviceName: ServiceName): boolean {
  void serviceName;
  const mode = getAgentServiceExecutionMode();
  return mode === "hybrid" && isAgentServiceLlmEnabled();
}
