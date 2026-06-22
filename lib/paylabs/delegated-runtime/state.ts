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

// ─── Macro-Node Phase Order ──────────────────────────────────
export const MACRO_PHASES: MacroNodePhase[] = [
  "discovery_planner",
  "payment_decision",
  "settlement_memory",
];

// ─── Tier → Phase Mapping ────────────────────────────────────
export const TIER_PHASE_MAP: Record<string, MacroNodePhase[]> = {
  easy: ["discovery_planner"],
  normal: ["discovery_planner", "payment_decision"],
  advanced: ["discovery_planner", "payment_decision", "settlement_memory"],
};

// ─── Service-to-Macro-Node Mapping ───────────────────────────
const SERVICE_MACRO_MAP: Record<string, MacroNodePhase> = {
  intent_planner: "discovery_planner",
  query_builder: "discovery_planner",
  signal_scout: "discovery_planner",
  intent_matcher: "payment_decision",
  source_verifier: "payment_decision",
  value_allocator: "payment_decision",
  trust_verifier: "payment_decision",
  payment_decider: "payment_decision",
  payment_router: "settlement_memory",
};

// ─── Tier Service Presets (canonical bundles) ────────────────
const TIER_SERVICE_PRESETS: Record<string, ServiceName[]> = {
  easy: ["intent_planner", "query_builder", "signal_scout"],
  normal: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
  ],
  advanced: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
    "payment_router",
  ],
};

const MACRO_NODE_FEE_USDC = 0.000001;
const SERVICE_EDGE_FEE_USDC = 0.000001;
const REGISTRY_CHECK_FEE_USDC = 0.000001;
const SOURCE_ACCESS_FEE_USDC = 0.000001;

// ─── Execution Plan Validator ─────────────────────────────────

export function validateAndLockExecutionPlan(
  tier: string,
  selectedMacroNodes: MacroNodePhase[],
  _selectedServices: ServiceName[],
  maxRegistryChecks: number,
  maxSourceAccesses: number,
): ExecutionPlan {
  const allowedPhases = TIER_PHASE_MAP[tier] || TIER_PHASE_MAP.easy;
  const validMacroNodes = selectedMacroNodes.filter((n) => allowedPhases.includes(n));
  const presetServices = TIER_SERVICE_PRESETS[tier] || TIER_SERVICE_PRESETS.easy;

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

  const macro_node_fees_usdc = validMacroNodes.length * MACRO_NODE_FEE_USDC;
  const service_edge_fees_usdc = presetServices.length * SERVICE_EDGE_FEE_USDC;
  const registry_check_fees_usdc = maxRegistryChecks * REGISTRY_CHECK_FEE_USDC;
  const source_access_fees_usdc = maxSourceAccesses * SOURCE_ACCESS_FEE_USDC;
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
