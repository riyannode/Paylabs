/**
 * Delegated Runtime State
 *
 * State factory and helpers for the orchestrator run state.
 * This is NOT a LangGraph Annotation — it's a plain object managed by the orchestrator.
 */

import type {
  OrchestratorRunState,
  ExecutionPlan,
  OrchestratorInput,
  BudgetSnapshot,
  MacroNodePhase,
  ServiceEvaluation,
  BrainPlanningOutput,
} from "./types";
import type { ServiceName } from "../agent-services/types";
import {
  TIER_PHASE_MAP,
  TIER_SERVICE_PRESETS,
  SERVICE_MACRO_MAP,
  FIXED_FEES_USDC,
} from "./quote-engine";

// ─── Re-exports for backward compatibility ───────────────────
export { TIER_PHASE_MAP };

// ─── Macro-Node Phase Order ──────────────────────────────────
export const MACRO_PHASES: MacroNodePhase[] = [
  "discovery_planner",
  "payment_decision",
  "settlement_memory",
];

// ─── Execution Plan Validator ─────────────────────────────────

export function validateAndLockExecutionPlan(
  tier: string,
  selectedMacroNodes: MacroNodePhase[],
  _selectedServices: ServiceName[],
  maxRegistryChecks: number,
  maxSourceAccesses: number,
): ExecutionPlan {
  const allowedPhases = TIER_PHASE_MAP[tier as keyof typeof TIER_PHASE_MAP] || TIER_PHASE_MAP.easy;
  const validMacroNodes = selectedMacroNodes.filter((n) => allowedPhases.includes(n));
  const presetServices = TIER_SERVICE_PRESETS[tier as keyof typeof TIER_SERVICE_PRESETS] || TIER_SERVICE_PRESETS.easy;

  const servicesByMacroNode: Record<MacroNodePhase, ServiceName[]> = {
    discovery_planner: [],
    payment_decision: [],
    settlement_memory: [],
  };
  for (const svc of presetServices) {
    const macroNode = SERVICE_MACRO_MAP[svc];
    if (macroNode && validMacroNodes.includes(macroNode)) {
      servicesByMacroNode[macroNode].push(svc);
    }
  }

  const macro_node_fees_usdc = validMacroNodes.length * FIXED_FEES_USDC.macroNode;
  const service_edge_fees_usdc = presetServices.length * FIXED_FEES_USDC.serviceEdge;
  const registry_check_fees_usdc = maxRegistryChecks * FIXED_FEES_USDC.registryCheck;
  const source_access_fees_usdc = maxSourceAccesses * FIXED_FEES_USDC.sourceAccess;
  const plannedCostUsdc =
    macro_node_fees_usdc + service_edge_fees_usdc +
    registry_check_fees_usdc + source_access_fees_usdc;

  return {
    selectedMacroNodes: validMacroNodes,
    selectedServices: presetServices,
    servicesByMacroNode,
    plannedCostUsdc,
    plannedCostBreakdown: {
      macro_node_fees_usdc,
      service_edge_fees_usdc,
      registry_check_fees_usdc,
      source_access_fees_usdc,
    },
    locked: true,
  };
}

// ─── State Factory ───────────────────────────────────────────

export function createOrchestratorState(input: OrchestratorInput): OrchestratorRunState {
  const phasesToRun = TIER_PHASE_MAP[input.routeTier] || TIER_PHASE_MAP.easy;

  const macroNodeProgress: Record<MacroNodePhase, "pending" | "running" | "completed" | "failed" | "skipped"> = {
    discovery_planner: phasesToRun.includes("discovery_planner") ? "pending" : "skipped",
    payment_decision: phasesToRun.includes("payment_decision") ? "pending" : "skipped",
    settlement_memory: phasesToRun.includes("settlement_memory") ? "pending" : "skipped",
  };

  return {
    discoveryRunId: input.discoveryRunId,
    userGoal: input.userGoal,
    userWallet: input.userWallet,
    userBudgetUsdc: input.userBudgetUsdc,
    routeTier: input.routeTier,
    orchestratorStatus: "running",
    budgetSnapshot: {
      totalBudgetUsdc: input.userBudgetUsdc,
      spentUsdc: 0,
      remainingUsdc: input.userBudgetUsdc,
      serviceSpend: {} as Record<ServiceName, number>,
      settledServiceFeesUsdc: 0,
      estimatedServiceFeesUsdc: 0,
    },
    macroNodeProgress,
    serviceEvaluations: [],
    consensusDecisions: [],
    paymentPlan: [],
    paymentEdges: [],
    safeProgressSummaries: [],
    delegatedRuntimeEnabled: true,
    brainPlanning: null,
    executionPlan: null,
    paymentGraph: [],
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

// ─── State Mutations ─────────────────────────────────────────

export function addServiceEvaluation(
  state: OrchestratorRunState,
  evaluation: ServiceEvaluation
): void {
  state.serviceEvaluations.push(evaluation);
}

export function updateBudgetSnapshot(
  state: OrchestratorRunState,
  serviceName: ServiceName,
  costUsdc: number,
  settled: boolean = false
): void {
  state.budgetSnapshot.serviceSpend[serviceName] =
    (state.budgetSnapshot.serviceSpend[serviceName] || 0) + costUsdc;
  state.budgetSnapshot.spentUsdc += costUsdc;
  state.budgetSnapshot.remainingUsdc =
    state.budgetSnapshot.totalBudgetUsdc - state.budgetSnapshot.spentUsdc;

  if (settled) {
    state.budgetSnapshot.settledServiceFeesUsdc += costUsdc;
  } else {
    state.budgetSnapshot.estimatedServiceFeesUsdc += costUsdc;
  }
}

export function setMacroPhaseStatus(
  state: OrchestratorRunState,
  phase: MacroNodePhase,
  status: "pending" | "running" | "completed" | "failed" | "skipped"
): void {
  state.macroNodeProgress[phase] = status;
}

export function addProgressSummary(
  state: OrchestratorRunState,
  summary: string
): void {
  state.safeProgressSummaries.push(summary);
}

export function markOrchestratorComplete(
  state: OrchestratorRunState,
  status: "completed" | "failed" | "cancelled",
  error?: string
): void {
  state.orchestratorStatus = status;
  state.completedAt = new Date().toISOString();
  if (error) state.error = error;
}
