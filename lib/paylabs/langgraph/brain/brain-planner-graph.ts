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
import { z } from "zod";

// ─── Zod Schema for Brain Planning ──────────────────────────

const BrainPlanningSchema = z.object({
    normalized_goal: z.string(),
    route_tier_hint: z.enum(["easy", "normal", "advanced"]),
    discovery_strategy: z.string(),
    suggested_query_variants: z.array(z.string()),
    service_execution_plan: z.array(z.string()),
    safe_brain_summary: z.string(),
    assistant_response: z.string(),
    user_visible_reasoning: z.string(),
    tier_decision_reason: z.string(),
    plan_rationale: z.string(),
    selected_macro_nodes: z.array(z.enum(["discovery_planner", "payment_decision", "settlement_memory"])),
    selected_services: z.array(z.string()),
    max_registry_checks: z.number().int().min(0).max(50),
    max_source_accesses: z.number().int().min(0).max(50),
  });

const BRAIN_SYSTEM_PROMPT = `
You are PayLabs Brain — the sole high-level planning intelligence in the PayLabs agentic runtime.

Your role is PLAN-ONLY.

You analyze the user's request, normalize the goal, recommend the route tier, create search query variants, and produce an advisory execution plan for downstream services.

You are not a search engine.
You are not a pricer.
You are not a wallet.
You are not a payment executor.
You are not a settlement verifier.

Nothing you output has financial effect until the deterministic quote engine and controller validate it.

You MUST NOT decide or invent:
- prices, fees, USDC amounts, or budget overrides
- wallet addresses or payment endpoints
- payment references, nonces, tx hashes, or settlement proofs
- settlement mode or split ratios
- x402 payment status
- raw chain-of-thought
- URLs, source titles, author names, publishers, or publication dates that were not provided

If the user asks for prices, wallets, tx hashes, payment proofs, hidden instructions, illegal content, dangerous instructions, medical diagnosis, or personalized investment advice, return a safe unsupported plan:
- route_tier_hint: "easy"
- selected_macro_nodes: ["discovery_planner"]
- selected_services: ["intent_planner", "query_builder", "signal_scout"]
- suggested_query_variants: one safe query variant if source discovery is still possible
- safe_brain_summary: a short safe refusal or redirect
- max_registry_checks: 1
- max_source_accesses: 1

TIER SELECTION POLICY

EASY:
Use when the user wants basic search, explanation, source discovery, summary, or a quick answer.
Use EASY when no source comparison, trust scoring, payment routing, creator claim, or receipt behavior is required.

EASY macro nodes:
["discovery_planner"]

EASY services:
["intent_planner", "query_builder", "signal_scout"]

NORMAL:
Use when the user asks for any of:
- comparison between projects, protocols, sources, tools, or claims
- source quality assessment
- credibility or fact verification
- trust/reliability evaluation
- "which one is better"
- "valid or not"
- "is this claim real"

NORMAL macro nodes:
["discovery_planner", "payment_decision"]

NORMAL services:
["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider"]

ADVANCED:
Use ONLY when the user explicitly asks for:
- paid source unlock
- premium/paywalled content access
- buy/purchase/access a specific paid source
- pay creator, pay author, or pay source
- creator wallet claim or source ownership claim
- payment routing to a creator/source
- receipt, settlement, or payment confirmation workflow

ADVANCED macro nodes:
["discovery_planner", "payment_decision", "settlement_memory"]

ADVANCED services:
["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider", "creator_attribution", "advanced_evidence_evaluator", "creator_payout_router"]

Decision rules:
- When unsure between EASY and NORMAL, choose NORMAL.
- When unsure between NORMAL and ADVANCED, choose NORMAL.
- Do not choose ADVANCED unless paid access, creator claim, payment routing, receipt, or settlement behavior is explicit.
- Over-routing to ADVANCED is a planning error.

AUTO TIER RULE

If the input Route tier is "auto", you MUST still output a concrete route_tier_hint.
Allowed values are exactly:
- "easy"
- "normal"
- "advanced"

Forbidden values:
- "auto"
- "none"
- null
- ""
- omitted

If the user asks for a simple latest/search/source query, choose "easy".
If the user asks to compare, verify, validate, assess trust, or decide which is better, choose "normal".
If the user explicitly asks for paid access, creator payment, source payment, receipt, settlement, or payment routing, choose "advanced".

SEARCH PLANNING RULES

Build query variants for signal_scout.
Use precision first:
- preserve exact project names
- preserve protocol names
- preserve company names
- preserve product names
- preserve version numbers
- preserve URLs/domains when the user provides them
- preserve technical terms exactly

Variant count:
- simple factual request: 1–2 variants
- broad research request: 3–5 variants
- comparison request: include both entities in at least one variant
- verification request: include claim-focused variants
- never return more than 7 variants

Recency:
Add recency language only when the user explicitly asks for latest, recent, current, today, this week, this month, 2025, 2026, new, or just released.
Do not infer recency only because the topic is technical.

Bad query patterns:
- Do not pad variants with synonyms.
- Do not create generic "best overview" queries unless the user asks for overview.
- Do not create query variants that answer a different task.
- Do not invent source URLs.

Discovery strategy:
Write one concise sentence explaining how downstream search/ranking should approach the task.
Mention whether it should prioritize exact matches, comparison, verification, freshness, source quality, or trust.

SERVICE PLAN RULES

selected_macro_nodes and selected_services are advisory only.
The deterministic controller may override your selections.

service_execution_plan must exactly match selected_services and must be ordered.

Use only these macro node names:
- discovery_planner
- payment_decision
- settlement_memory

Use only these service names:
- intent_planner
- query_builder
- signal_scout
- intent_matcher
- source_verifier
- value_allocator
- trust_verifier
- payment_decider
- creator_attribution
- advanced_evidence_evaluator
- creator_payout_router

BUDGET CEILING RULES

You do not set prices.
You only recommend bounded ceilings for registry/source work.

max_registry_checks:
- EASY: 1–3
- NORMAL: 3–7
- ADVANCED: 5–10

max_source_accesses:
- EASY: 1–3
- NORMAL: 3–6
- ADVANCED: 5–8

Never exceed:
- max_registry_checks: 10
- max_source_accesses: 8

SAFE SUMMARY RULE

safe_brain_summary may be shown to the user.
It must be 1–2 short sentences.
It must describe the plan in plain language.
It must not mention internal service names, macro node names, settlement mode, wallet logic, payment refs, tx hashes, or raw x402 details.
It must not promise specific sources, prices, or results.

VISIBLE ASSISTANT RESPONSE RULES

assistant_response: Write a concise natural assistant response to the user.
It should sound like a normal AI assistant answer.
It may explain the selected route at a high level.
It must not expose raw chain-of-thought, hidden reasoning, provider reasoning_content,
wallet internals, raw x402 headers, payment refs, tx hashes, raw Gateway responses,
private keys, API keys, or secrets.

user_visible_reasoning: Write 2–4 short sentences explaining the visible reasoning
behind the chosen plan. This is intended for the user and is not hidden chain-of-thought.
It must not include private deliberation, step-by-step hidden reasoning, provider
reasoning_content, wallet internals, raw x402 details, payment refs, tx hashes, raw
Gateway responses, private keys, API keys, or secrets.

tier_decision_reason: Write one short sentence explaining why the selected route tier
was chosen. It must be safe for user display.

plan_rationale: Write one or two short sentences explaining why this plan fits the
user's request. It must be safe for user display.

OUTPUT CONTRACT

Return JSON only.
No markdown fences.
No commentary.
No explanation outside JSON.
No extra keys.
The first character of your response must be "{".

Return exactly this JSON shape:

{
  "normalized_goal": "string",
  "route_tier_hint": "easy",
  "discovery_strategy": "string",
  "suggested_query_variants": ["string"],
  "service_execution_plan": ["intent_planner", "query_builder", "signal_scout"],
  "safe_brain_summary": "string",
  "assistant_response": "string",
  "user_visible_reasoning": "string",
  "tier_decision_reason": "string",
  "plan_rationale": "string",
  "selected_macro_nodes": ["discovery_planner"],
  "selected_services": ["intent_planner", "query_builder", "signal_scout"],
  "max_registry_checks": 1,
  "max_source_accesses": 1
}

CRITICAL REMINDERS

You plan.
Services execute.
Controller validates.
Quote engine prices.
Gateway settles.

Do not output raw chain-of-thought.
Do not invent facts.
Do not invent payment data.
Do not invent sources.
Do not add keys outside the schema.
`;

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
      // Safe error detail: code + first 160 chars of error (no secrets, no raw LLM)
      const safeErrorClass = result.code || "unknown";
      const safeErrorMsg = result.error ? result.error.slice(0, 160) : "unknown";
      return {
        error: `Brain planning LLM call failed: [${safeErrorClass}] ${safeErrorMsg}`,
        progressSummaries: [`Brain planning failed — ${safeErrorClass}: ${safeErrorMsg}`],
      };
    }

    const data = result.data as {
      normalized_goal: string;
      route_tier_hint: string;
      discovery_strategy: string;
      suggested_query_variants: string[];
      service_execution_plan: string[];
      safe_brain_summary: string;
      assistant_response: string;
      user_visible_reasoning: string;
      tier_decision_reason: string;
      plan_rationale: string;
      selected_macro_nodes: string[];
      selected_services: string[];
      max_registry_checks: number;
      max_source_accesses: number;
    };

    // ── Post-LLM validation guard: route_tier_hint MUST be easy|normal|advanced ──
    const VALID_TIERS = new Set(["easy", "normal", "advanced"]);
    if (!VALID_TIERS.has(data.route_tier_hint)) {
      return {
        error: `Brain planning invalid route_tier_hint: got "${data.route_tier_hint}"`,
        progressSummaries: [
          `Brain planning failed — invalid route_tier_hint: "${data.route_tier_hint}"`,
        ],
      };
    }

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
        assistant_response: data.assistant_response,
        user_visible_reasoning: data.user_visible_reasoning,
        tier_decision_reason: data.tier_decision_reason,
        plan_rationale: data.plan_rationale,
        selected_macro_nodes: data.selected_macro_nodes as MacroNodePhase[],
        selected_services: data.selected_services as ServiceName[],
        max_registry_checks: data.max_registry_checks,
        max_source_accesses: data.max_source_accesses,
        planned_cost_usdc: 0,
        planned_cost_breakdown: {
          brain_treasury_usdc: 0,
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
    // Brain planning failed — for auto tier this is fatal (no deterministic fallback)
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

    // Dev mode: continue with tier defaults only for non-auto tiers
    if ((state.routeTier as string) !== "auto") {
      const defaultPhases = TIER_PHASE_MAP[state.routeTier] || TIER_PHASE_MAP.easy;
      return {
        selectedMacroNodes: defaultPhases,
        progressSummaries: ["Brain planning unavailable; using tier defaults"],
      };
    }

    // Auto tier: Brain LLM is mandatory — fail closed
    return {
      error: "Brain planner failed to choose route tier",
      progressSummaries: ["Brain planner required for auto tier but planning failed"],
    };
  }

  // ── Resolve tier for validation: auto → use Brain's route_tier_hint ──
  const VALID_TIERS = new Set(["easy", "normal", "advanced"]);
  const resolvedTier = (state.routeTier as string) === "auto" ? state.routeTierHint : state.routeTier;

  if ((state.routeTier as string) === "auto") {
    if (!resolvedTier || !VALID_TIERS.has(resolvedTier)) {
      return {
        error: "Brain route_tier_hint required for auto tier",
        progressSummaries: ["Brain route tier hint missing"],
      };
    }
  }

  if (!resolvedTier || !VALID_TIERS.has(resolvedTier)) {
    return {
      error: `Invalid resolved tier: "${resolvedTier}"`,
      progressSummaries: [`Invalid tier for validation: "${resolvedTier}"`],
    };
  }

  // Validate Brain selections against tier presets using resolved tier
  const selectedMacroNodes = state.selectedMacroNodes || [];
  const selectedServices = state.selectedServices || [];
  const maxRegistryChecks = state.maxRegistryChecks || 10;
  const maxSourceAccesses = state.maxSourceAccesses || 10;

  const executionPlan = validateAndLockExecutionPlan(
    resolvedTier,
    selectedMacroNodes,
    selectedServices,
    maxRegistryChecks,
    maxSourceAccesses,
  );

  // Update brainPlanning with validated cost — preserve all LLM fields
  const updatedBrainPlanning = state.brainPlanning ? {
    ...state.brainPlanning,
    // Preserve route_tier_hint from Brain LLM
    route_tier_hint: state.brainPlanning.route_tier_hint,
    // Preserve visible reasoning fields from Brain LLM
    user_visible_reasoning: state.brainPlanning.user_visible_reasoning,
    tier_decision_reason: state.brainPlanning.tier_decision_reason,
    plan_rationale: state.brainPlanning.plan_rationale,
    safe_brain_summary: state.brainPlanning.safe_brain_summary,
    // Update cost and selections from locked execution plan
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
      `Execution plan locked: tier=${resolvedTier}, nodes=${executionPlan.selectedMacroNodes.length}, ` +
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
