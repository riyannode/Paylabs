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
  DelegatedRouteTier,
} from "./types";
import type { ServiceName } from "../agent-services/types";
import {
  TIER_PHASE_MAP,
  FIXED_FEES_USDC,
  quoteDelegatedRun,
} from "./quote-engine";

// ─── Auto-Tier Resolution ────────────────────────────────────

export type AutoTierResult =
  | { ok: true; tier: DelegatedRouteTier }
  | { ok: false; error: string };

/**
 * Resolve "auto" tier using Brain's route_tier_hint.
 * For explicit tiers (easy/normal/advanced), use as-is.
 * For "auto", REQUIRE valid Brain hint — fail closed if missing/invalid.
 */
export function resolveAutoTier(
  requestedTier: string,
  brainHint: string | undefined,
): AutoTierResult {
  if (requestedTier === "auto") {
    if (brainHint === "easy" || brainHint === "normal" || brainHint === "advanced") {
      return { ok: true, tier: brainHint };
    }
    return { ok: false, error: `Brain planner required for auto tier: got "${brainHint || "none"}"` };
  }
  if (requestedTier === "easy" || requestedTier === "normal" || requestedTier === "advanced") {
    return { ok: true, tier: requestedTier };
  }
  return { ok: true, tier: "easy" };
}

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
  const routeTier = tier === "easy" || tier === "normal" || tier === "advanced" ? tier : "easy";

  // Delegate to quote-engine (single source of truth for pricing)
  const quote = quoteDelegatedRun({
    routeTier,
    userBudgetUsdc: Infinity, // no budget check here — just cost computation
    maxRegistryChecks,
    maxSourceAccesses,
  });

  return {
    selectedMacroNodes: quote.selectedMacroNodes,
    selectedServices: quote.selectedServices,
    servicesByMacroNode: quote.servicesByMacroNode,
    plannedCostUsdc: quote.plannedCostUsdc,
    plannedCostBreakdown: {
      brain_treasury_usdc: FIXED_FEES_USDC.brainTreasury,
      macro_node_fees_usdc: quote.macroNodeFeesUsdc,
      service_edge_fees_usdc: quote.serviceEdgeFeesUsdc,
      registry_check_fees_usdc: quote.registryCheckFeesUsdc,
      source_access_fees_usdc: quote.sourceAccessFeesUsdc,
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
