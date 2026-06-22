/**
 * Brain Planner LangGraph
 *
 * The single Brain orchestrator graph.
 * Runs Brain LLM planning, validates execution plan, builds tiered summaries.
 *
 * Graph: START → brain_planning → validate_plan → build_summaries → END
 *
 * Rules:
 * - Brain is ALWAYS LLM-assisted
 * - Brain output is ADVISORY — deterministic controller validates
 * - Brain CANNOT set wallets, final prices, payment refs, settlement refs
 * - Brain CANNOT sign or settle payments
 * - Must NOT call SERVICE_HANDLERS directly
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { BrainPlannerState, type BrainPlannerStateType } from "../shared/state";
import type { MacroNodePhase, DelegatedRouteTier, BrainPlanningOutput } from "../../delegated-runtime/types";
import type { ServiceName } from "../../agent-services/types";
import {
  TIER_PHASE_MAP,
  validateAndLockExecutionPlan,
} from "../../delegated-runtime/state";

// ─── Zod Schema for Brain Planning ──────────────────────────

const BrainPlanningSchema = (() => {
  const { z } = require("zod");
  return z.object({
    normalized_goal: z.string(),
    route_tier_hint: z.enum(["easy", "normal", "advanced"]),
    discovery_strategy: z.string(),
    suggested_query_variants: z.array(z.string()),
    service_execution_plan: z.array(z.string()),
    safe_brain_summary: z.string(),
    selected_macro_nodes: z.array(z.enum(["discovery_planner", "payment_decision", "settlement_memory"])),
    selected_services: z.array(z.string()),
    max_registry_checks: z.number().int().min(0).max(50),
    max_source_accesses: z.number().int().min(0).max(50),
  });
})();

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
  "normalized_goal": string,
  "route_tier_hint": "easy" | "normal" | "advanced",
  "discovery_strategy": string,
  "suggested_query_variants": string[],
  "service_execution_plan": string[],
  "safe_brain_summary": string,
  "selected_macro_nodes": string[],
  "selected_services": string[],
  "max_registry_checks": number,
  "max_source_accesses": number
}

Prices are fixed from registry — do NOT invent prices. The system computes cost deterministically from your selections.

Return ONLY the JSON object. No markdown fences, no explanation before or after.`;

// ─── Node: Brain LLM Planning ───────────────────────────────

async function brainPlanningNode(state: BrainPlannerStateType) {
  try {
    const { generateStructuredJson } = await import("../../../ai/llm-structured");

    const result = await generateStructuredJson({
      agentName: "brain_planner",
      routeTier: "normal",
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      userPrompt: `User goal: "${state.userGoal}"
Budget: ${state.userBudgetUsdc} USDC
Route tier: ${state.routeTier}
Discovery run: ${state.discoveryRunId}

Analyze this goal and produce a structured execution plan.`,
      schema: BrainPlanningSchema,
    });

    if (!result.ok) {
      return {
        error: "Brain planning LLM call failed",
        progressSummaries: ["Brain planning failed — LLM call unsuccessful"],
      };
    }

    const data = result.data as {
      normalized_goal: string;
      route_tier_hint: string;
      discovery_strategy: string;
      suggested_query_variants: string[];
      service_execution_plan: string[];
      safe_brain_summary: string;
      selected_macro_nodes: string[];
      selected_services: string[];
      max_registry_checks: number;
      max_source_accesses: number;
    };

    return {
      normalizedGoal: data.normalized_goal,
      routeTierHint: data.route_tier_hint as DelegatedRouteTier,
      discoveryStrategy: data.discovery_strategy,
      suggestedQueryVariants: data.suggested_query_variants,
      serviceExecutionPlan: data.service_execution_plan,
      safeBrainSummary: data.safe_brain_summary,
      selectedMacroNodes: data.selected_macro_nodes as MacroNodePhase[],
      selectedServices: data.selected_services as ServiceName[],
      maxRegistryChecks: data.max_registry_checks,
      maxSourceAccesses: data.max_source_accesses,
      brainPlanning: {
        normalized_goal: data.normalized_goal,
        route_tier_hint: data.route_tier_hint as DelegatedRouteTier,
        discovery_strategy: data.discovery_strategy,
        suggested_query_variants: data.suggested_query_variants,
        service_execution_plan: data.service_execution_plan,
        safe_brain_summary: data.safe_brain_summary,
        selected_macro_nodes: data.selected_macro_nodes as MacroNodePhase[],
        selected_services: data.selected_services as ServiceName[],
        max_registry_checks: data.max_registry_checks,
        max_source_accesses: data.max_source_accesses,
        planned_cost_usdc: 0,
        planned_cost_breakdown: {
          macro_node_fees_usdc: 0,
          service_edge_fees_usdc: 0,
          registry_check_fees_usdc: 0,
          source_access_fees_usdc: 0,
        },
      } as BrainPlanningOutput,
      progressSummaries: [
        `Brain planning: strategy="${data.discovery_strategy.slice(0, 60)}", ` +
        `${data.service_execution_plan.length} services planned, ` +
        `${data.suggested_query_variants.length} query variants`,
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: `Brain planning unavailable: ${msg}`,
      progressSummaries: [`Brain planning error: ${msg}`],
    };
  }
}

// ─── Node: Validate Execution Plan ──────────────────────────

async function validatePlanNode(state: BrainPlannerStateType) {
  if (state.error) {
    // Brain planning failed — check if LLM required
    try {
      const { isLlmRequired } = await import("../../../ai/llm");
      if (isLlmRequired()) {
        return {
          progressSummaries: ["Brain planning failed — PAYLABS_LLM_REQUIRED=true, cannot continue"],
        };
      }
    } catch {
      // ignore import error
    }

    // Dev mode: continue with tier defaults
    const defaultPhases = TIER_PHASE_MAP[state.routeTier] || TIER_PHASE_MAP.easy;
    return {
      selectedMacroNodes: defaultPhases,
      progressSummaries: ["Brain planning unavailable; using tier defaults"],
    };
  }

  // Validate Brain selections against tier presets
  const selectedMacroNodes = state.selectedMacroNodes || [];
  const selectedServices = state.selectedServices || [];
  const maxRegistryChecks = state.maxRegistryChecks || 10;
  const maxSourceAccesses = state.maxSourceAccesses || 10;

  const executionPlan = validateAndLockExecutionPlan(
    state.routeTier,
    selectedMacroNodes,
    selectedServices,
    maxRegistryChecks,
    maxSourceAccesses,
  );

  // Update brainPlanning with validated cost
  const updatedBrainPlanning = state.brainPlanning ? {
    ...state.brainPlanning,
    planned_cost_usdc: executionPlan.plannedCostUsdc,
    planned_cost_breakdown: executionPlan.plannedCostBreakdown,
    selected_macro_nodes: executionPlan.selectedMacroNodes,
    selected_services: executionPlan.selectedServices,
  } : undefined;

  return {
    selectedMacroNodes: executionPlan.selectedMacroNodes,
    selectedServices: executionPlan.selectedServices,
    plannedCostUsdc: executionPlan.plannedCostUsdc,
    brainPlanning: updatedBrainPlanning,
    progressSummaries: [
      `Execution plan locked: tier=${state.routeTier}, nodes=${executionPlan.selectedMacroNodes.length}, ` +
      `services=${executionPlan.selectedServices.length}, plannedCost=${executionPlan.plannedCostUsdc.toFixed(6)} USDC`,
    ],
  };
}

// ─── Node: Build Summaries ──────────────────────────────────

async function buildSummariesNode(state: BrainPlannerStateType) {
  const selectedMacroNodes = state.selectedMacroNodes || [];
  const safeBrainSummary = state.safeBrainSummary || "Brain planning completed";

  // Build final_summary from safe brain summary
  const finalSummary = `Brain: ${safeBrainSummary}. ` +
    `Phases: ${selectedMacroNodes.join(", ")}. ` +
    `Cost: ${(state.plannedCostUsdc || 0).toFixed(6)} USDC.`;

  return {
    finalSummary,
    progressSummaries: [`Summaries built: final_summary ready`],
  };
}

// ─── Graph Wiring ───────────────────────────────────────────

const graph = new StateGraph(BrainPlannerState)
  .addNode("brain_planning", brainPlanningNode)
  .addNode("validate_plan", validatePlanNode)
  .addNode("build_summaries", buildSummariesNode)
  .addEdge(START, "brain_planning")
  .addEdge("brain_planning", "validate_plan")
  .addEdge("validate_plan", "build_summaries")
  .addEdge("build_summaries", END)
  .compile();

// ─── Public API ─────────────────────────────────────────────

export interface RunBrainPlannerGraphInput {
  discoveryRunId: string;
  userGoal: string;
  routeTier: DelegatedRouteTier;
  userBudgetUsdc: number;
  userWallet: string;
}

export interface RunBrainPlannerGraphOutput {
  ok: boolean;
  brainPlanning: BrainPlanningOutput | null;
  selectedMacroNodes: MacroNodePhase[];
  selectedServices: ServiceName[];
  plannedCostUsdc: number;
  finalSummary: string;
  progressSummaries: string[];
  error: string | null;
}

/**
 * Run the Brain Planner graph (the ONLY Brain path).
 */
export async function runBrainPlannerGraph(
  input: RunBrainPlannerGraphInput
): Promise<RunBrainPlannerGraphOutput> {
  try {
    const result = await graph.invoke({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      userWallet: input.userWallet,
      // Initialize
      suggestedQueryVariants: [],
      serviceExecutionPlan: [],
      selectedMacroNodes: [],
      selectedServices: [],
      maxRegistryChecks: 10,
      maxSourceAccesses: 10,
      plannedCostUsdc: 0,
      progressSummaries: [],
    });

    const selectedMacroNodes = result.selectedMacroNodes || [];
    const safeBrainSummary = result.safeBrainSummary || "Brain planning completed";
    const finalSummary = `Brain: ${safeBrainSummary}. Phases: ${selectedMacroNodes.join(", ")}. Cost: ${(result.plannedCostUsdc || 0).toFixed(6)} USDC.`;

    return {
      ok: !result.error,
      brainPlanning: result.brainPlanning || null,
      selectedMacroNodes,
      selectedServices: result.selectedServices || [],
      plannedCostUsdc: result.plannedCostUsdc || 0,
      finalSummary,
      progressSummaries: result.progressSummaries || [],
      error: result.error || null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      brainPlanning: null,
      selectedMacroNodes: [],
      selectedServices: [],
      plannedCostUsdc: 0,
      finalSummary: `Brain graph failed: ${msg}`,
      progressSummaries: [`Brain graph error: ${msg}`],
      error: msg,
    };
  }
}
