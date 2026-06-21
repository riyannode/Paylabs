/**
 * PayLabs Run Orchestrator
 *
 * THE single Brain. Controls three macro-node phases:
 * 1. Discovery Planner
 * 2. Payment Decision Layer
 * 3. Settlement & Memory Layer
 *
 * The Brain is ALWAYS LLM-assisted. It outputs structured planning
 * context that the deterministic controller uses for phase execution.
 *
 * Brain output is advisory only — the deterministic controller remains
 * source of truth for: tier routing, service execution order, edge
 * allowlist, budget guardrails, final status, audit-only settlement.
 *
 * Tier behavior:
 *   easy/scout: run Discovery Planner only
 *   normal/decision: run Discovery Planner + Payment Decision Layer
 *   advanced/commerce: run all three phases
 *
 * Do NOT create: discovery brain, payment brain, settlement brain.
 * This is the ONLY orchestrator.
 */

import { z } from "zod";
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
import { runDiscoveryPlanner } from "./macro-nodes/discovery-planner";
import { runPaymentDecision } from "./macro-nodes/payment-decision";
import { runSettlementMemory } from "./macro-nodes/settlement-memory";

// ─── Brain Planning Schema ──────────────────────────────────

const BrainPlanningSchema = z.object({
  normalized_goal: z.string(),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  discovery_strategy: z.string(),
  suggested_query_variants: z.array(z.string()),
  service_execution_plan: z.array(z.string()),
  safe_brain_summary: z.string(),
  // ── Deterministic quote planning (LLM selects, cost computed separately) ──
  selected_macro_nodes: z.array(z.enum(["discovery_planner", "payment_decision", "settlement_memory"])),
  selected_services: z.array(z.string()),
  max_registry_checks: z.number().int().min(0).max(50),
  max_source_accesses: z.number().int().min(0).max(50),
});

const BRAIN_SYSTEM_PROMPT = `You are the PayLabs Brain — a planning intelligence that analyzes the user's goal and produces a structured execution plan for the delegated agent services.

You output structured JSON only. You CANNOT:
- Control wallet or signing operations
- Choose arbitrary payment endpoints
- Set final payment amounts (prices are fixed from registry)
- Bypass edge allowlists or budget guardrails
- Approve settlements or generate payment references
- Output raw chain-of-thought

You CAN:
- Normalize and clarify the user's goal
- Suggest a route tier (easy/normal/advanced) based on goal complexity and budget
- Propose a discovery strategy (what to search for, how to rank)
- Suggest query variants for the query_builder service
- Outline the execution plan for the 9 agent services
- Select which macro-nodes and services to run for this specific goal
- Recommend max registry/source checks needed
- Provide a safe human-readable summary

Route tier determines which macro-nodes run:
- easy: discovery_planner only (3 services: intent_planner, query_builder, signal_scout)
- normal: discovery_planner + payment_decision (8 services: adds intent_matcher, source_verifier, value_allocator, trust_verifier, payment_decider)
- advanced: all three macro-nodes (9 services: adds payment_router)

Return a JSON object with EXACTLY these fields (no extra fields, no renamed fields):
{
  "normalized_goal": string,          // The user's goal, cleaned up and clarified
  "route_tier_hint": "easy" | "normal" | "advanced",  // Suggested tier based on complexity
  "discovery_strategy": string,       // What to search for and how to rank results
  "suggested_query_variants": string[],  // 2-4 query variants for the query_builder
  "service_execution_plan": string[],    // Ordered list of service steps to execute
  "safe_brain_summary": string,       // Human-readable summary (no secrets, no CoT)
  "selected_macro_nodes": string[],   // Which macro-nodes to run (e.g. ["discovery_planner"])
  "selected_services": string[],      // Which services to run (e.g. ["intent_planner","query_builder","signal_scout"])
  "max_registry_checks": number,      // How many registry checks needed (0-50)
  "max_source_accesses": number       // How many source accesses needed (0-50)
}

Prices are fixed from registry — do NOT invent prices. The system computes cost deterministically from your selections.

Return ONLY the JSON object. No markdown fences, no explanation before or after.`;

// ─── LLM Brain Planning Step ────────────────────────────────

type BrainPlanningResult =
  | { ok: true; data: BrainPlanningOutput }
  | { ok: false; error: string };

async function runBrainPlanningStep(
  input: OrchestratorInput
): Promise<BrainPlanningResult> {
  try {
    const { generateStructuredJson } = await import("@/lib/ai/llm-structured");

    const result = await generateStructuredJson<z.infer<typeof BrainPlanningSchema>>({
      agentName: "brain_planner",
      routeTier: "normal", // Brain uses normal tier config
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      userPrompt: `User goal: "${input.userGoal}"
Budget: ${input.userBudgetUsdc} USDC
Route tier: ${input.routeTier}
Discovery run: ${input.discoveryRunId}

Analyze this goal and produce a structured execution plan.`,
      schema: BrainPlanningSchema,
    });

    if (!result.ok) {
      return { ok: false, error: "Brain planning LLM call failed" };
    }

    // ── Raw Brain selections (validated + cost computed by executionPlan) ──
    return {
      ok: true,
      data: {
        normalized_goal: result.data.normalized_goal,
        route_tier_hint: result.data.route_tier_hint,
        discovery_strategy: result.data.discovery_strategy,
        suggested_query_variants: result.data.suggested_query_variants,
        service_execution_plan: result.data.service_execution_plan,
        safe_brain_summary: result.data.safe_brain_summary,
        selected_macro_nodes: result.data.selected_macro_nodes as MacroNodePhase[],
        selected_services: result.data.selected_services as ServiceName[],
        max_registry_checks: result.data.max_registry_checks,
        max_source_accesses: result.data.max_source_accesses,
        planned_cost_usdc: 0,
        planned_cost_breakdown: { macro_node_fees_usdc: 0, service_edge_fees_usdc: 0, registry_check_fees_usdc: 0, source_access_fees_usdc: 0 },
      },
    };
  } catch {
    return { ok: false, error: "Brain planning unavailable" };
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Execute a delegated discovery run.
 *
 * This is the main entry point for the delegated runtime.
 * When PAYLABS_DELEGATED_RUNTIME_ENABLED=true, this replaces
 * the existing proposeSourcePath flow.
 *
 * Brain is ALWAYS LLM-assisted. Services default to deterministic.
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

  // ── Brain Planning Step (always LLM) ──
  const brainResult = await runBrainPlanningStep(input);

  if (brainResult.ok) {
    state.brainPlanning = brainResult.data;

    // ── Lock execution plan: validate Brain selections against tier presets ──
    const executionPlan = validateAndLockExecutionPlan(
      input.routeTier,
      brainResult.data.selected_macro_nodes,
      brainResult.data.selected_services,
      brainResult.data.max_registry_checks,
      brainResult.data.max_source_accesses,
    );
    state.executionPlan = executionPlan;

    // Update brainPlanning with validated cost
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
    // Check PAYLABS_LLM_REQUIRED: if true, Brain failure = fail closed
    const { isLlmRequired } = await import("@/lib/ai/llm");
    const llmRequired = isLlmRequired();

    if (llmRequired) {
      // Fail closed: Brain is required, cannot continue without it
      markOrchestratorComplete(state, "failed", "Brain planning failed and PAYLABS_LLM_REQUIRED=true");
      addProgressSummary(state, "Brain planning failed — LLM required, orchestrator stopped");
      return buildOutput(state);
    }

    // Dev mode: Brain failure is non-fatal, continue with deterministic services
    addProgressSummary(state, "Brain planning unavailable; continuing in deterministic service mode.");
  }

  try {
    // ── Determine which phases to run from execution plan (or tier fallback) ──
    const activePhases = state.executionPlan
      ? state.executionPlan.selectedMacroNodes
      : phasesToRun;
    const activeServices = state.executionPlan
      ? state.executionPlan.selectedServices
      : [];

    // ── Phase 1: Discovery Planner (always runs) ──
    setMacroPhaseStatus(state, "discovery_planner", "running");

    const discoveryResult = await runDiscoveryPlanner(state, { selectedServices: activeServices });

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

    // If easy/scout tier or payment_decision not in plan, stop here
    if (!activePhases.includes("payment_decision")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 2: Payment Decision Layer ──
    setMacroPhaseStatus(state, "payment_decision", "running");

    const paymentResult = await runPaymentDecision(state, discoveryResult.rankedCandidates, { selectedServices: activeServices });

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

    // If normal/decision tier or settlement_memory not in plan, stop here
    if (!activePhases.includes("settlement_memory")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 3: Settlement & Memory Layer ──
    setMacroPhaseStatus(state, "settlement_memory", "running");

    const settlementResult = await runSettlementMemory(state, paymentResult.approvedItems, { selectedServices: activeServices });

    if (!settlementResult.ok) {
      setMacroPhaseStatus(state, "settlement_memory", "failed");
      markOrchestratorComplete(state, "failed", settlementResult.error || "Settlement failed");
      return buildOutput(state);
    }

    setMacroPhaseStatus(state, "settlement_memory", "completed");
    addProgressSummary(
      state,
      `Settlement completed (audit-only): ${settlementResult.routedItems.length} planned, ${settlementResult.failedItems.length} failed validation. Mode: payment_plan_ready.`
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
    brainPlanning: state.brainPlanning,
    paymentGraph: state.paymentGraph,
    error: state.error,
  };
}
