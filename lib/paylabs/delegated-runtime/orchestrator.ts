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
  BrainPlanningOutput,
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

// ─── Brain Planning Schema ──────────────────────────────────

const BrainPlanningSchema = z.object({
  normalized_goal: z.string(),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  discovery_strategy: z.string(),
  suggested_query_variants: z.array(z.string()),
  service_execution_plan: z.array(z.string()),
  safe_brain_summary: z.string(),
});

const BRAIN_SYSTEM_PROMPT = `You are the PayLabs Brain — a planning intelligence that analyzes the user's goal and produces a structured execution plan for the delegated agent services.

You output structured JSON only. You CANNOT:
- Control wallet or signing operations
- Choose arbitrary payment endpoints
- Set final payment amounts
- Bypass edge allowlists or budget guardrails
- Approve settlements or generate payment references
- Output raw chain-of-thought

You CAN:
- Normalize and clarify the user's goal
- Suggest a route tier (easy/normal/advanced) based on goal complexity and budget
- Propose a discovery strategy (what to search for, how to rank)
- Suggest query variants for the query_builder service
- Outline the execution plan for the 9 agent services
- Provide a safe human-readable summary

Return structured JSON only.`;

// ─── LLM Brain Planning Step ────────────────────────────────

async function runBrainPlanningStep(
  input: OrchestratorInput
): Promise<BrainPlanningOutput | null> {
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
      // Brain LLM failure is non-fatal — orchestrator continues with defaults
      return null;
    }

    return {
      normalized_goal: result.data.normalized_goal,
      route_tier_hint: result.data.route_tier_hint,
      discovery_strategy: result.data.discovery_strategy,
      suggested_query_variants: result.data.suggested_query_variants,
      service_execution_plan: result.data.service_execution_plan,
      safe_brain_summary: result.data.safe_brain_summary,
    };
  } catch {
    // Brain planning failure is non-fatal
    return null;
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
  const brainOutput = await runBrainPlanningStep(input);
  state.brainPlanning = brainOutput;

  if (brainOutput) {
    addProgressSummary(
      state,
      `Brain planning: strategy="${brainOutput.discovery_strategy.slice(0, 60)}", ${brainOutput.service_execution_plan.length} services planned, ${brainOutput.suggested_query_variants.length} query variants`
    );
    // Brain may suggest a different tier, but controller uses the original
    if (brainOutput.route_tier_hint !== input.routeTier) {
      addProgressSummary(
        state,
        `Brain suggested tier "${brainOutput.route_tier_hint}" but controller uses original tier "${input.routeTier}"`
      );
    }
  } else {
    addProgressSummary(state, "Brain planning: skipped (LLM unavailable or failed)");
  }

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
    error: state.error,
  };
}
