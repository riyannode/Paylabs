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
You are PayLabs Brain — the planning intelligence. You analyze the user goal, recommend a route tier, build search query variants, and produce a structured execution plan.

ROLE: Plan only. You do not search, price, sign, or settle. Your output is advisory — downstream services and controller validate everything.

SAFETY: Never output prices, wallets, tx hashes, payment refs, settlement proofs, raw chain-of-thought, URLs/titles/sources you were not given, or any secrets. If asked for these, return a safe refusal plan with route_tier_hint="easy", selected_macro_nodes=["discovery_planner"], max_registry_checks=1, max_source_accesses=1.

=== TIER SELECTION ===
You MUST output a concrete route_tier_hint — never "auto", "none", null, "".

EASY — basic search, explanation, summary, quick answer. No comparison, claim verification, trust scoring, paid source unlock, payment-decision phase, or creator payout phase needed. Entry x402 payment may still be processed by PayLabs before the run starts.
Macro nodes: ["discovery_planner"]
Services: ["intent_planner", "query_builder", "signal_scout_basics"]
max_registry_checks: 1-3. max_source_accesses: 1-3.

NORMAL — comparison, verification, fact-checking, trust evaluation, "is this claim valid", "which is better". Includes payment-decision phase for source evaluation. Entry x402 payment is processed, and the payment-decision phase runs for source evaluation. No creator payout phase.
Macro nodes: ["discovery_planner", "payment_decision"]
Services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider"]
max_registry_checks: 3-7. max_source_accesses: 3-6.

ADVANCED — ONLY when user explicitly asks for: paid source unlock, creator payment, receipt, settlement, payment routing to creator/source. Includes payment-decision phase AND creator payout phase.
Macro nodes: ["discovery_planner", "payment_decision", "settlement_memory"]
Services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider", "creator_attribution", "advanced_evidence_evaluator", "creator_payout_router"]
max_registry_checks: 5-10. max_source_accesses: 5-8.

When unsure: EASY↔NORMAL→choose NORMAL. NORMAL↔ADVANCED→choose NORMAL. Never over-route to ADVANCED.

=== PAYMENT PHASE VOCABULARY ===
Use these exact terms. Do NOT say "no payment needed" — it is misleading because entry x402 payment is always processed.
- "entry x402 payment" = always processed for every run (Easy, Normal, Advanced)
- "payment-decision phase" = only Normal and Advanced — evaluates whether to pay for specific sources
- "paid source unlock" = only Advanced — unlocks premium/paywalled sources
- "creator payout phase" = only Advanced — routes payment to content creators

=== QUERY VARIANTS ===
1-2 for simple requests, 3-5 for broad/comparison, max 7. Preserve exact names, protocols, versions, URLs. Do not pad with synonyms. Do not invent URLs.

=== SERVICE PLAN ===
selected_macro_nodes and selected_services are advisory — the controller may override. service_execution_plan must match selected_services in order.

=== JSON OUTPUT FORMAT ===
No markdown, no commentary, no extra keys. First character must be "{". Return exactly:
{"normalized_goal":"string","route_tier_hint":"easy","discovery_strategy":"string","suggested_query_variants":["string"],"service_execution_plan":["intent_planner","query_builder","signal_scout_basics"],"safe_brain_summary":"string","assistant_response":"string","user_visible_reasoning":"string","tier_decision_reason":"string","plan_rationale":"string","selected_macro_nodes":["discovery_planner"],"selected_services":["intent_planner","query_builder","signal_scout_basics"],"max_registry_checks":1,"max_source_accesses":1}

=== FIELD RULES ===

safe_brain_summary:
- 1-2 sentences, plain language, no internals.

assistant_response:
- MUST answer the user's actual question directly with real information, facts, or explanation.
- MUST NOT be a planning/status sentence (no "I will find", "I will search", "Let me look").
- MUST NOT mention internal nodes, x402 internals, wallet addresses, Gateway, settlement, quote engine, or service fees unless the user explicitly asked about them.
- If live RSSHub sources are not attached to this run, answer from general knowledge but DO NOT claim it is source-backed. Say: "This answer is based on general knowledge. Live source links may be available in the source summary if PayLabs found matching feeds."
- For latest/news queries where live sources may not be attached, add uncertainty: "AI/crypto news changes quickly. This overview is based on general knowledge unless live source links are attached below."
- 3-6 sentences max. Be useful, not overconfident.
- MUST NEVER start with or contain these planning phrases:
  "I will find", "I will search", "I am processing", "Let me find",
  "I'll look", "I'll search", "Saya akan mencari", "Saya sedang",
  "Mohon tunggu", "I'm gathering", "Searching for", "I need to find".

route reasoning (user_visible_reasoning):
- 2-4 sentences explaining WHY this tier was selected.
- MUST be user-friendly — no jargon, no internal node names.
- MUST distinguish the three payment phases:
  (1) entry x402 payment — happens for ALL runs
  (2) payment-decision phase — only Normal/Advanced
  (3) paid source unlock / creator payout — only Advanced
- MUST NOT say "no payment needed" or "no payment".

tier_decision_reason:
- 1 sentence. Must use the payment phase vocabulary above.
- Format: "Tier: reason; payment status."
- MUST NOT say "no payment needed".

plan_rationale:
- 1-2 sentences on the execution plan rationale.

=== GOOD EXAMPLES ===

Example 1 — Query: "ai news today?"
assistant_response: "AI news changes quickly, so this answer should be treated as a brief overview unless live source links are attached. Recent AI discussion centers on agentic systems, model efficiency, data-center capacity, safety regulation, and enterprise deployment. Key players like OpenAI, Anthropic, and Google continue releasing new models and tools. Check the source summary for live links when available."
tier_decision_reason: "Easy: broad news/explanation request; entry x402 payment was processed, but no claim verification, payment-decision phase, paid source unlock, or creator payout phase was needed."

Example 2 — Query: "valid ga klaim AWS WAF memakai x402 untuk AI bot monetization"
assistant_response: "This is a claim-validation request, so it needs source checking rather than a generic explanation. PayLabs should compare the claim against official AWS material and credible technical sources before treating it as valid. x402 is a real HTTP-native payment protocol, but whether AWS WAF specifically supports it for AI bot monetization requires verification against current AWS documentation."
tier_decision_reason: "Normal: claim validation request; entry x402 payment was processed, and the payment-decision phase runs for source evaluation and trust scoring."

Example 3 — Query: "how x402 works"
assistant_response: "x402 is an HTTP-native payment protocol where a server responds with 402 Payment Required and payment instructions. The client completes the requested payment, retries with a payment proof header, and the server verifies before returning the protected resource. It is designed for API and agent payment flows where very small payments happen programmatically without pre-registration or API keys."
tier_decision_reason: "Easy: simple protocol explanation; entry x402 payment was processed, but no claim verification, paid source unlock, or creator payout phase was needed."

Example 4 — Query: "crypto news today"
assistant_response: "Crypto markets move fast, so treat this as a general overview unless live source links are attached. Recent crypto discussion covers regulatory developments, Bitcoin ETF flows, Ethereum ecosystem upgrades, stablecoin adoption, and institutional interest. Market sentiment shifts with macroeconomic data and policy announcements. Check the source summary for live links from CoinDesk, Cointelegraph, or similar outlets when available."
tier_decision_reason: "Easy: broad news/explanation request; entry x402 payment was processed, but no claim verification, payment-decision phase, paid source unlock, or creator payout phase was needed."

Example 5 — Query: "Pay creator to unlock premium research report"
assistant_response: "This request involves paying a creator to access premium content, which requires the full settlement pipeline. PayLabs will identify the creator, verify content ownership, route payment through the settlement layer, and unlock the requested research report. The creator receives payment directly via the payout router."
tier_decision_reason: "Advanced: explicit paid source unlock and creator payout request; entry x402 payment was processed, the payment-decision phase runs, and the creator payout phase handles settlement."
`;

// ─── Deterministic Tier Hint (nudge only, not final output) ──

function computeTierHint(goal: string): string {
  const g = goal.toLowerCase();
  const normalSignals = [
    "valid", "real", "klaim", "claim", "verify", "comparison", "compare",
    "vs", "trust", "better", "fact-check", "fact check", "credible",
    "reliable", "which", "assess", "evaluation", "truth",
  ];
  const advancedSignals = [
    "receipt", "settlement", "pay creator", "paid source", "unlock",
    "payment routing", "payout", "buy access", "purchase access",
    "premium", "paywall", "pay author",
  ];
  for (const s of advancedSignals) {
    if (g.includes(s)) return "advanced";
  }
  for (const s of normalSignals) {
    if (g.includes(s)) return "normal";
  }
  return "easy";
}

// ─── Node: Brain LLM Planning ───────────────────────────────

async function brainPlanningNode(state: BrainPlannerStateType) {
  try {
    const { generateStructuredJson } = await import("../../../ai/llm-structured");

    // Deterministic tier hint as nudge — Brain still outputs final route_tier_hint
    const tierHintCandidate = computeTierHint(state.userGoal);
    const tierHintLine = (state.routeTier as string) === "auto"
      ? `\nSuggested route tier from deterministic classifier: ${tierHintCandidate}. Use this as a hint only — you must still return the final route_tier_hint in your JSON.`
      : "";

    const result = await generateStructuredJson({
      agentName: "brain_planner",
      routeTier: "normal",
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      userPrompt: `User goal: "${state.userGoal}"
Budget: ${state.userBudgetUsdc} USDC
Route tier: ${state.routeTier}
Discovery run: ${state.discoveryRunId}${tierHintLine}

Analyze this goal and produce a structured execution plan.`,
      schema: BrainPlanningSchema,
    });

    // Safe diagnostic: trace generateStructuredJson result (no raw LLM, no secrets)
    const rAny = result as unknown as Record<string, unknown>;
    console.error("[brain-planner] generateStructuredJson result:", {
      ok: rAny.ok,
      code: rAny.code || null,
      hasData: !!rAny.data,
      hasMeta: !!rAny.meta,
      metaKeys: rAny.meta ? Object.keys(rAny.meta as Record<string, unknown>) : [],
      route_tier_hint: rAny.ok && rAny.data ? ((rAny.data as Record<string, unknown>).route_tier_hint ?? null) : null,
    });

    if (!result.ok) {
      // Safe error detail: code + first 220 chars of error (no secrets, no raw LLM)
      const safeErrorClass = result.code || "unknown";
      const safeErrorMsg = result.error ? result.error.slice(0, 220) : "unknown";
      return {
        error: `Brain planning LLM call failed: [${safeErrorClass}] ${safeErrorMsg}`,
        progressSummaries: [`Brain planning failed — ${safeErrorClass}: ${safeErrorMsg}`],
        brainLlmDiag: {
          error_code: result.code ?? "unknown",
          error_safe: safeErrorMsg,
          provider: (result.meta as Record<string, unknown>)?.provider ?? "unknown",
          model: (result.meta as Record<string, unknown>)?.model ?? "unknown",
          agent_name: (result.meta as Record<string, unknown>)?.agent_name ?? "unknown",
          mode: (result.meta as Record<string, unknown>)?.mode ?? "unknown",
          max_tokens: (result.meta as Record<string, unknown>)?.max_tokens ?? null,
          timeout_ms: (result.meta as Record<string, unknown>)?.timeout_ms ?? null,
          streaming: (result.meta as Record<string, unknown>)?.streaming ?? null,
          force_non_streaming_body: (result.meta as Record<string, unknown>)?.force_non_streaming_body ?? null,
        },
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
        brainLlmDiag: {
          ...(result.meta as Record<string, unknown> || {}),
          error_code: "INVALID_TIER_HINT",
          error_safe: `got "${data.route_tier_hint}"`,
          json_found: true,
          parse_ok: true,
          validation_ok: false,
        },
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
      brainLlmDiag: {
        provider: (result.meta as Record<string, unknown>)?.provider ?? "unknown",
        model: (result.meta as Record<string, unknown>)?.model ?? "unknown",
        agent_name: (result.meta as Record<string, unknown>)?.agent_name ?? "unknown",
        mode: (result.meta as Record<string, unknown>)?.mode ?? "unknown",
        max_tokens: (result.meta as Record<string, unknown>)?.max_tokens ?? null,
        timeout_ms: (result.meta as Record<string, unknown>)?.timeout_ms ?? null,
        streaming: (result.meta as Record<string, unknown>)?.streaming ?? null,
        force_non_streaming_body: (result.meta as Record<string, unknown>)?.force_non_streaming_body ?? null,
        json_found: true,
        parse_ok: true,
        validation_ok: true,
        error_code: null,
        error_safe: null,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: `Brain planning unavailable: ${msg}`,
      progressSummaries: [`Brain planning error: ${msg}`],
      brainLlmDiag: {
        error_code: "BRAIN_GRAPH_ERROR",
        error_safe: msg.slice(0, 220),
        json_found: null,
        parse_ok: null,
        validation_ok: null,
        provider: "unknown",
        model: "unknown",
      },
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
  /** Safe diagnostic metadata from generateStructuredJson (no secrets, no raw LLM) */
  brainLlmDiag?: Record<string, unknown>;
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

    // Safe diagnostic: trace graph state brainLlmDiag (no secrets)
    const hasBrainDiag = (result as Record<string, unknown>).brainLlmDiag !== undefined && (result as Record<string, unknown>).brainLlmDiag !== null;
    console.error("[brain-graph] final state brainLlmDiag:", {
      hasBrainDiag,
      brainDiagKeys: hasBrainDiag ? Object.keys((result as Record<string, unknown>).brainLlmDiag as Record<string, unknown>) : [],
      hasError: !!result.error,
      hasBrainPlanning: !!result.brainPlanning,
    });

    return {
      ok: !result.error,
      brainPlanning: result.brainPlanning || null,
      selectedMacroNodes,
      selectedServices: result.selectedServices || [],
      plannedCostUsdc: result.plannedCostUsdc || 0,
      finalSummary,
      progressSummaries: result.progressSummaries || [],
      error: result.error || null,
      brainLlmDiag: (result as Record<string, unknown>).brainLlmDiag as Record<string, unknown> | undefined,
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
