/**
 * PayLabs Run Orchestrator
 *
 * THE single Brain. Controls three macro-node phases:
 * 1. Discovery Planner
 * 2. Payment Decision Layer
 * 3. Settlement & Memory Layer
 *
 * Tier behavior:
 *   easy/scout: run Discovery Planner only
 *   normal/decision: run Discovery Planner + Payment Decision Layer
 *   advanced/commerce: run all three phases
 *
 * Do NOT create: discovery brain, payment brain, settlement brain.
 * This is the ONLY orchestrator.
 */

import type {
  OrchestratorInput,
  OrchestratorOutput,
  DelegatedRouteTier,
} from "./types";
import {
  createOrchestratorState,
  TIER_PHASE_MAP,
  setMacroPhaseStatus,
  markOrchestratorComplete,
  addProgressSummary,
} from "./state";
import { runDiscoveryPlanner } from "./macro-nodes/discovery-planner";
import { runPaymentDecision } from "./macro-nodes/payment-decision";
import { runSettlementMemory } from "./macro-nodes/settlement-memory";

// ─── Public API ──────────────────────────────────────────────

/**
 * Execute a delegated discovery run.
 *
 * This is the main entry point for the delegated runtime.
 * When PAYLABS_DELEGATED_RUNTIME_ENABLED=true, this replaces
 * the existing proposeSourcePath flow.
 */
export async function executeDelegatedDiscoveryRun(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const state = createOrchestratorState(input);
  const phasesToRun = TIER_PHASE_MAP[input.routeTier] || TIER_PHASE_MAP.easy;

  addProgressSummary(
    state,
    `Orchestrator started: tier=${input.routeTier}, budget=${input.userBudgetUsdc} USDC, phases=${phasesToRun.join(",")}`
  );

  try {
    // ── Phase 1: Discovery Planner (always runs) ──
    setMacroPhaseStatus(state, "discovery_planner", "running");

    const discoveryResult = await runDiscoveryPlanner(state);

    if (!discoveryResult.ok) {
      setMacroPhaseStatus(state, "discovery_planner", "failed");
      markOrchestratorComplete(state, "failed", discoveryResult.error || "Discovery planner failed");
      return buildOutput(state);
    }

    setMacroPhaseStatus(state, "discovery_planner", "completed");
    addProgressSummary(
      state,
      `Discovery Planner completed: ${discoveryResult.rankedCandidates.length} candidates, goal: "${(discoveryResult.normalizedGoal || "").slice(0, 80)}"`
    );

    // If easy/scout tier, stop here
    if (!phasesToRun.includes("payment_decision")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 2: Payment Decision Layer ──
    setMacroPhaseStatus(state, "payment_decision", "running");

    const paymentResult = await runPaymentDecision(state, discoveryResult.rankedCandidates);

    if (!paymentResult.ok) {
      setMacroPhaseStatus(state, "payment_decision", "failed");
      markOrchestratorComplete(state, "failed", paymentResult.error || "Payment decision failed");
      return buildOutput(state);
    }

    setMacroPhaseStatus(state, "payment_decision", "completed");
    addProgressSummary(
      state,
      `Payment Decision completed: ${paymentResult.approvedItems.length} approved, ${paymentResult.skippedItems.length} skipped`
    );

    // Store payment plan in state
    state.paymentPlan = paymentResult.approvedItems.map((item) => ({
      itemId: item.feed_item_id,
      sourceUrl: item.source_url,
      sourceTitle: item.source_title,
      priceUsdc: item.approved_price_usdc,
      approved: true,
      skipReason: null,
      finalScore: item.final_score,
      riskScore: item.risk_score,
    }));

    // If normal/decision tier, stop here
    if (!phasesToRun.includes("settlement_memory")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 3: Settlement & Memory Layer ──
    setMacroPhaseStatus(state, "settlement_memory", "running");

    const settlementResult = await runSettlementMemory(state, paymentResult.approvedItems);

    if (!settlementResult.ok) {
      setMacroPhaseStatus(state, "settlement_memory", "failed");
      markOrchestratorComplete(state, "failed", settlementResult.error || "Settlement failed");
      return buildOutput(state);
    }

    setMacroPhaseStatus(state, "settlement_memory", "completed");
    addProgressSummary(
      state,
      `Settlement completed: ${settlementResult.paidItems.length} routed, ${settlementResult.failedPayments.length} failed`
    );

    markOrchestratorComplete(state, "completed");
    return buildOutput(state);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    markOrchestratorComplete(state, "failed", `Orchestrator error: ${msg}`);
    return buildOutput(state);
  }
}

// ─── Internal Helpers ────────────────────────────────────────

function buildOutput(state: ReturnType<typeof createOrchestratorState>): OrchestratorOutput {
  const phasesCompleted = (Object.entries(state.macroNodeProgress) as Array<[
    string,
    string,
  ]>)
    .filter(([, status]) => status === "completed")
    .map(([phase]) => phase as OrchestratorOutput["phasesCompleted"][number]);

  return {
    discoveryRunId: state.discoveryRunId,
    status: state.orchestratorStatus,
    routeTier: state.routeTier,
    phasesCompleted,
    safeProgressSummaries: state.safeProgressSummaries,
    budgetSnapshot: state.budgetSnapshot,
    consensusDecisions: state.consensusDecisions,
    paymentPlan: state.paymentPlan,
    paymentEdges: state.paymentEdges,
    serviceEvaluations: state.serviceEvaluations,
    error: state.error,
  };
}
