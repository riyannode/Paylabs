/**
 * Delegated Runtime State
 *
 * State factory and helpers for the orchestrator run state.
 * This is NOT a LangGraph Annotation — it's a plain object managed by the orchestrator.
 */

import type {
  OrchestratorRunState,
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
    },
    macroNodeProgress,
    serviceEvaluations: [],
    consensusDecisions: [],
    paymentPlan: [],
    paymentEdges: [],
    safeProgressSummaries: [],
    delegatedRuntimeEnabled: true,
    brainPlanning: null,
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
  costUsdc: number
): void {
  state.budgetSnapshot.serviceSpend[serviceName] =
    (state.budgetSnapshot.serviceSpend[serviceName] || 0) + costUsdc;
  state.budgetSnapshot.spentUsdc += costUsdc;
  state.budgetSnapshot.remainingUsdc =
    state.budgetSnapshot.totalBudgetUsdc - state.budgetSnapshot.spentUsdc;
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
