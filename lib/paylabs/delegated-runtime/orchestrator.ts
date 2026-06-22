/**
 * PayLabs Run Orchestrator
 *
 * THE single Brain. Controls three macro-node phases via LangGraph:
 * 1. Discovery Planner
 * 2. Payment Decision Layer
 * 3. Settlement & Memory Layer
 *
 * The Brain is ALWAYS LLM-assisted (via brain-planner-graph).
 * Macro-node phases execute via their respective LangGraph graphs.
 *
 * Tier behavior:
 *   easy: Discovery Planner only
 *   normal: Discovery Planner + Payment Decision
 *   advanced: all three phases
 */

import type {
  OrchestratorInput,
  OrchestratorOutput,
  DelegatedRouteTier,
  MacroNodePhase,
  BrainPlanningOutput,
} from "./types";
import type { ServiceName } from "../agent-services/types";
import {
  createOrchestratorState,
  TIER_PHASE_MAP,
  setMacroPhaseStatus,
  markOrchestratorComplete,
  addProgressSummary,
  validateAndLockExecutionPlan,
} from "./state";

// ─── Public API ──────────────────────────────────────────────

/**
 * Execute a delegated discovery run using LangGraph.
 *
 * Entry point for the delegated runtime.
 * Brain uses LangGraph brain-planner-graph (always LLM-assisted).
 * Macro-node phases use their respective LangGraph graphs.
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

  // ── Brain Planning (LangGraph) ──
  const brainResult = await runBrainPlanning(input);

  if (brainResult.ok) {
    state.brainPlanning = brainResult.data;

    const executionPlan = validateAndLockExecutionPlan(
      input.routeTier,
      brainResult.data.selected_macro_nodes,
      brainResult.data.selected_services,
      brainResult.data.max_registry_checks,
      brainResult.data.max_source_accesses,
    );
    state.executionPlan = executionPlan;

    state.brainPlanning.planned_cost_usdc = executionPlan.plannedCostUsdc;
    state.brainPlanning.planned_cost_breakdown = executionPlan.plannedCostBreakdown;
    state.brainPlanning.selected_macro_nodes = executionPlan.selectedMacroNodes;
    state.brainPlanning.selected_services = executionPlan.selectedServices;

    addProgressSummary(
      state,
      `Execution plan locked: tier=${input.routeTier}, nodes=${executionPlan.selectedMacroNodes.length}, services=${executionPlan.selectedServices.length}, plannedCost=${executionPlan.plannedCostUsdc.toFixed(6)} USDC`
    );
    addProgressSummary(
      state,
      `Brain planning: strategy="${brainResult.data.discovery_strategy.slice(0, 60)}", ${brainResult.data.service_execution_plan.length} services planned, ${brainResult.data.suggested_query_variants.length} query variants`
    );
  } else {
    const { isLlmRequired } = await import("@/lib/ai/llm");
    if (isLlmRequired()) {
      markOrchestratorComplete(state, "failed", "Brain planning failed and PAYLABS_LLM_REQUIRED=true");
      addProgressSummary(state, "Brain planning failed — LLM required, orchestrator stopped");
      return buildOutput(state);
    }
    addProgressSummary(state, "Brain planning unavailable; continuing with tier defaults.");
  }

  try {
    const activePhases = state.executionPlan
      ? state.executionPlan.selectedMacroNodes
      : phasesToRun;
    const activeServices = state.executionPlan
      ? state.executionPlan.selectedServices
      : [];

    // ── Phase 1: Discovery Planner (LangGraph) ──
    setMacroPhaseStatus(state, "discovery_planner", "running");

    const { runDiscoveryPlannerGraph } = await import("../langgraph/macro-nodes/discovery-planner-graph");
    const discoveryResult = await runDiscoveryPlannerGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      selectedServices: activeServices,
    });

    if (!discoveryResult.ok) {
      setMacroPhaseStatus(state, "discovery_planner", "failed");
      markOrchestratorComplete(state, "failed", discoveryResult.error || "Discovery planner failed");
      return buildOutput(state);
    }

    // Merge graph results into state
    for (const ev of discoveryResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of discoveryResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    setMacroPhaseStatus(state, "discovery_planner", "completed");
    addProgressSummary(
      state,
      `Discovery Planner completed: ${discoveryResult.rankedCandidates.length} candidates`
    );

    if (!activePhases.includes("payment_decision")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 2: Payment Decision (LangGraph) ──
    setMacroPhaseStatus(state, "payment_decision", "running");

    const { runPaymentDecisionGraph } = await import("../langgraph/macro-nodes/payment-decision-graph");
    const paymentResult = await runPaymentDecisionGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      candidates: discoveryResult.rankedCandidates,
      selectedServices: activeServices,
    });

    if (!paymentResult.ok) {
      setMacroPhaseStatus(state, "payment_decision", "failed");
      markOrchestratorComplete(state, "failed", paymentResult.error || "Payment decision failed");
      return buildOutput(state);
    }

    for (const ev of paymentResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of paymentResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    setMacroPhaseStatus(state, "payment_decision", "completed");
    addProgressSummary(
      state,
      `Payment Decision completed: ${paymentResult.approvedItems.length} approved, ${paymentResult.skippedItems.length} skipped`
    );

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

    if (!activePhases.includes("settlement_memory")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 3: Settlement Memory (LangGraph) ──
    setMacroPhaseStatus(state, "settlement_memory", "running");

    const { runSettlementMemoryGraph } = await import("../langgraph/macro-nodes/settlement-memory-graph");
    const settlementResult = await runSettlementMemoryGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      approvedItems: paymentResult.approvedItems,
      selectedServices: activeServices,
    });

    if (!settlementResult.ok) {
      setMacroPhaseStatus(state, "settlement_memory", "failed");
      markOrchestratorComplete(state, "failed", settlementResult.error || "Settlement failed");
      return buildOutput(state);
    }

    for (const ev of settlementResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of settlementResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    setMacroPhaseStatus(state, "settlement_memory", "completed");
    addProgressSummary(
      state,
      `Settlement completed: ${settlementResult.routedItems.length} routed, ${settlementResult.failedItems.length} failed. Mode: audit-only.`
    );

    markOrchestratorComplete(state, "completed");
    return buildOutput(state);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    markOrchestratorComplete(state, "failed", `Orchestrator error: ${msg}`);
    return buildOutput(state);
  }
}

// ─── Brain Planning (LangGraph) ──────────────────────────────

async function runBrainPlanning(
  input: OrchestratorInput
): Promise<{ ok: true; data: BrainPlanningOutput } | { ok: false; error: string }> {
  try {
    const { runBrainPlannerGraph } = await import("../langgraph/brain/brain-planner-graph");
    const result = await runBrainPlannerGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      userWallet: input.userWallet,
    });

    if (result.ok && result.brainPlanning) {
      return { ok: true, data: result.brainPlanning };
    }
    return { ok: false, error: result.error || "Brain planning failed" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Brain graph error: ${msg}` };
  }
}

// ─── Output Builders ─────────────────────────────────────────

function buildOutput(state: ReturnType<typeof createOrchestratorState>): OrchestratorOutput {
  const phasesCompleted = (Object.entries(state.macroNodeProgress) as Array<[string, string]>)
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
    brainPlanning: state.brainPlanning,
    paymentGraph: state.paymentGraph,
    tieredSummaries: buildTieredSummaries(state),
    error: state.error,
  };
}

function buildTieredSummaries(state: ReturnType<typeof createOrchestratorState>): OrchestratorOutput["tieredSummaries"] {
  const summaries: Record<string, string | undefined> = {
    final_summary: state.safeProgressSummaries.join(" | "),
  };

  const discoveryEvals = state.serviceEvaluations.filter((e) => e.macroNode === "discovery_planner");
  if (discoveryEvals.length > 0) {
    const candidateCount = state.serviceEvaluations
      .filter((e) => e.serviceName === "signal_scout" && e.output)
      .reduce((count, e) => {
        const rc = (e.output as Record<string, unknown>)?.ranked_candidates as unknown[] | undefined;
        return count + (rc?.length || 0);
      }, 0);
    summaries.easy_summary = `Discovery: ${candidateCount} candidates found.`;
  }

  const paymentEvals = state.serviceEvaluations.filter((e) => e.macroNode === "payment_decision");
  if (paymentEvals.length > 0) {
    const deciderEval = paymentEvals.find((e) => e.serviceName === "payment_decider");
    if (deciderEval?.output) {
      const d = deciderEval.output as Record<string, unknown>;
      const approved = (d.approved_items as unknown[])?.length || 0;
      const skipped = (d.skipped_items as unknown[])?.length || 0;
      summaries.normal_summary = `Payment Decision: ${approved} approved, ${skipped} skipped.`;
    }
  }

  const settlementEvals = state.serviceEvaluations.filter((e) => e.macroNode === "settlement_memory");
  if (settlementEvals.length > 0) {
    const routerEval = settlementEvals.find((e) => e.serviceName === "payment_router");
    if (routerEval?.output) {
      const r = routerEval.output as Record<string, unknown>;
      const routed = (r.routed_items as unknown[])?.length || 0;
      summaries.advanced_summary = `Settlement: ${routed} items routed.`;
    }
  }

  return summaries as unknown as OrchestratorOutput["tieredSummaries"];
}
