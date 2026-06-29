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

EASY — basic search, explanation, summary, quick answer. No comparison, claim verification, trust scoring, payment-decision phase, paid source unlock, or creator payout phase. Entry x402 payment may be processed before the run depending on production entry gating.
Macro nodes: ["discovery_planner"]
Services: ["intent_planner", "query_builder", "signal_scout_basics"]
max_registry_checks: 1-3. max_source_accesses: 1-3.

NORMAL — comparison, verification, fact-checking, trust evaluation, "is this claim valid", "which is better". Includes payment-decision phase for source evaluation and creator payout phase for creator attribution/distribution. No paid source unlock unless the user explicitly asks to unlock premium/paywalled content.
Macro nodes: ["discovery_planner", "payment_decision", "settlement_memory"]
Services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider", "creator_attribution", "creator_payout_router"]
max_registry_checks: 3-7. max_source_accesses: 3-6.

ADVANCED — ONLY when user explicitly asks for paid source unlock, deeper evidence evaluation, creator payment, receipt, settlement, or payment routing to creator/source. Includes payment-decision phase, paid source unlock, advanced evidence evaluation, and creator payout phase.
Macro nodes: ["discovery_planner", "payment_decision", "settlement_memory"]
Services: ["intent_planner", "query_builder", "signal_scout", "intent_matcher", "source_verifier", "value_allocator", "trust_verifier", "payment_decider", "creator_attribution", "advanced_evidence_evaluator", "creator_payout_router"]
max_registry_checks: 5-10. max_source_accesses: 5-8.

When unsure: EASY↔NORMAL→choose NORMAL. NORMAL↔ADVANCED→choose NORMAL. Never over-route to ADVANCED unless paid unlock/deeper settlement/evidence is explicitly requested.

=== PAYMENT PHASE VOCABULARY ===
Use these exact terms. Do NOT say "no payment needed" — it is misleading in PayLabs.

- "entry x402 payment" = the user-facing entry/payment gate before or at run start when production gating is enabled
- "payment-decision phase" = Normal and Advanced — evaluates source value, trust, quality, and payment decisions
- "creator payout phase" = Normal and Advanced — performs creator attribution/distribution and routes eligible creator payouts
- "paid source unlock" = Advanced only — unlocks premium/paywalled sources when explicitly requested
- "advanced evidence evaluation" = Advanced only — performs deeper evidence evaluation before creator payout routing

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
- MUST be substantive — 4-6 sentences that actually inform the reader. Generic filler like "news changes quickly" is NOT an answer.
- MUST NOT be a planning/status sentence (no "I will find", "I will search", "Let me look").
- MUST NOT mention internal nodes, x402 internals, wallet addresses, Gateway, settlement, quote engine, or service fees unless the user explicitly asked about them.
- MUST NOT output a numbered source list [1]/[2]/[3] with titles, domains, or URLs. Source links are rendered separately by the frontend. Your job is to ANSWER the question, not list sources.
- If live RSSHub sources are not attached to this run, answer from general knowledge but DO NOT claim it is source-backed. Add: "Live source links may be available below if PayLabs found matching feeds."
- For latest/news queries: provide a substantive overview of the current landscape, key developments, major players, and what to watch. Do NOT just say "news changes quickly."
- MUST NEVER start with or contain these planning phrases:
  "I will find", "I will search", "I am processing", "Let me find",
  "I'll look", "I'll search", "Saya akan mencari", "Saya sedang",
  "Mohon tunggu", "I'm gathering", "Searching for", "I need to find".

user_visible_reasoning (route reasoning):
- 3-5 sentences explaining WHY this tier was selected and what the run will do.
- MUST be user-friendly — no jargon, no internal node names.
- MUST explain what the user gets from this run: what kind of sources will be searched, what analysis will happen, and what the output will contain.
- MUST distinguish these phases using exact vocabulary:
  (1) entry x402 payment — production entry/payment gate when enabled
  (2) payment-decision phase — Normal and Advanced only
  (3) creator payout phase — Normal and Advanced only
  (4) paid source unlock and advanced evidence evaluation — Advanced only
- MUST NOT say "no payment needed" or "no payment".
- For Easy: explain that the run searches for relevant sources, evaluates them for relevance, and returns the best matches with source links. Mention it does not run payment-decision phase, paid source unlock, or creator payout phase.
- For Normal: explain that the run performs deeper source evaluation, cross-references claims, and runs payment-decision phase and creator payout phase. Mention it does not run paid source unlock.
- For Advanced: explain the full pipeline including paid source unlock, advanced evidence evaluation, and creator payout routing.

tier_decision_reason:
- 2-3 sentences. Must use the payment phase vocabulary above.
- MUST explicitly mention that the entry x402 payment applies for this run.
- MUST explain which phases are active and which are skipped, with a brief reason.
- MUST NOT say "no payment needed" or "no payment" — the entry x402 payment always applies.
- For Easy: state that entry x402 payment is processed, but the run skips the payment-decision phase and creator payout phase because the query is a straightforward search/explanation that does not require source trust evaluation or creator attribution.
- For Normal: state that entry x402 payment is processed, and the run includes the payment-decision phase and creator payout phase because the query requires source verification or comparison. Note that paid source unlock is not included unless explicitly requested.
- For Advanced: state that entry x402 payment is processed, and the run includes the full pipeline — payment-decision phase, paid source unlock, advanced evidence evaluation, and creator payout phase — because the user explicitly requested premium content access or deeper settlement.

plan_rationale:
- 1-2 sentences on the execution plan rationale.

=== GOOD EXAMPLES ===

Example 1 — Query: "ai news today?"
assistant_response: "The AI industry is moving fast across several fronts right now. Large language models are getting more capable and efficient, with companies like OpenAI, Anthropic, Google, and Meta competing on reasoning, multimodality, and context length. Enterprise adoption is accelerating — businesses are deploying AI agents for customer support, code generation, and data analysis at scale. Meanwhile, regulators in the EU, US, and Asia are tightening rules around AI safety, transparency, and data usage. The chip supply chain remains a bottleneck, with Nvidia, AMD, and custom silicon makers racing to meet demand. Open-source models from Mistral, Llama, and DeepSeek are closing the gap with proprietary offerings."
user_visible_reasoning: "This is a broad AI news request, so PayLabs will search across major AI news sources and technology outlets for the latest developments. The run will collect articles from RSSHub feeds covering AI research, product launches, and industry moves, then rank them by relevance and recency. This runs the entry x402 payment gate, but does not include a payment-decision phase, paid source unlock, or creator payout phase — it is focused on discovery and source delivery."
tier_decision_reason: "This is a broad AI news request classified as Easy tier. The entry x402 payment is processed for this run, but it skips the payment-decision phase and creator payout phase because the query is a straightforward news search that does not require source trust evaluation or creator attribution — PayLabs simply discovers and delivers the most relevant sources."

Example 2 — Query: "valid ga klaim AWS WAF memakai x402 untuk AI bot monetization"
assistant_response: "This claim needs careful fact-checking against official AWS documentation. x402 is a real HTTP-native payment protocol developed by the IETF for machine-to-machine micropayments — it uses the 402 status code to gate API access behind per-request payments. However, AWS WAF is a web application firewall focused on bot mitigation, rate limiting, and request filtering — it is not a payment layer. AWS has not announced any x402 integration in WAF. The claim likely conflates two separate capabilities: bot management (WAF's domain) and programmatic payment gating (x402's domain). Cross-referencing with AWS docs and x402 specifications would be needed to confirm this is inaccurate."
user_visible_reasoning: "This is a claim-validation question mixing AWS WAF and x402 protocol, so PayLabs needs to cross-reference multiple authoritative sources rather than just returning news. The run will search for official AWS documentation, x402 protocol specs, and credible technical analysis to verify or debunk the claim. This runs the payment-decision phase to evaluate source trust and relevance, plus the creator payout phase for any sources that contribute to the verification. Paid source unlock is not needed since the claim can be checked against public documentation."
tier_decision_reason: "This is a claim-validation request classified as Normal tier because it requires cross-referencing multiple authoritative sources. The entry x402 payment is processed, and the run also includes the payment-decision phase to evaluate source trust and relevance, plus the creator payout phase for sources contributing to the verification. Paid source unlock is not included since the claim can be checked against publicly available documentation."

Example 3 — Query: "how x402 works"
assistant_response: "x402 is an HTTP-native payment protocol designed for machine-to-machine transactions. When a client requests a resource, the server responds with HTTP 402 Payment Required and includes payment instructions in the response headers. The client then completes the payment using a stablecoin like USDC through a payment facilitator such as Circle Gateway, and retries the original request with a payment proof header attached. The server verifies the payment proof and returns the protected resource if valid. The entire flow happens programmatically over HTTP — no API keys, no user accounts, no pre-registration required. This makes it ideal for AI agent commerce, per-request API billing, and content monetization where traditional payment flows are too heavy."
user_visible_reasoning: "This is a straightforward protocol explanation, so PayLabs will search for technical documentation, implementation guides, and real-world x402 usage examples. The run will collect sources from RSSHub feeds covering blockchain protocols, API infrastructure, and developer tooling, then return the most relevant and authoritative matches. This runs the entry x402 payment gate, but does not include a payment-decision phase, paid source unlock, or creator payout phase — it is a direct knowledge retrieval."
tier_decision_reason: "This is a protocol explanation request classified as Easy tier. The entry x402 payment is processed for this run, but it skips the payment-decision phase and creator payout phase because the query is a direct knowledge retrieval about how x402 works — it does not require source trust evaluation or creator attribution."

Example 4 — Query: "crypto news today"
assistant_response: "The crypto market is seeing significant regulatory and institutional momentum. In the US, the SEC and CFTC are refining their frameworks for digital asset classification, with recent court decisions shaping how tokens are treated as securities or commodities. Bitcoin ETF inflows have been strong, signaling continued institutional interest, while Ethereum's ecosystem is expanding with Layer 2 scaling solutions and DeFi protocol upgrades. Stablecoin adoption is growing — USDC and USDT are increasingly used for cross-border payments and as settlement rails in fintech infrastructure. Meanwhile, newer chains like Solana and Base are competing for developer mindshare with lower fees and faster finality. Watch for macroeconomic signals too — crypto markets remain correlated with risk assets and Fed policy expectations."
user_visible_reasoning: "This is a broad crypto news request, so PayLabs will search across major crypto news outlets and industry sources for the latest market developments, regulatory updates, and protocol news. The run will collect articles from RSSHub feeds covering CoinDesk, Cointelegraph, CryptoSlate, The Block, and Binance announcements, then rank them by relevance and recency. This runs the entry x402 payment gate, but does not include a payment-decision phase, paid source unlock, or creator payout phase — it is focused on discovery and source delivery."
tier_decision_reason: "This is a broad crypto news request classified as Easy tier. The entry x402 payment is processed for this run, but it skips the payment-decision phase and creator payout phase because the query is a straightforward news search that does not require source trust evaluation or creator attribution — PayLabs discovers and delivers the most relevant crypto news sources."

Example 5 — Query: "compare Bitcoin and Ethereum market trend"
assistant_response: "Bitcoin and Ethereum are showing divergent market dynamics. Bitcoin continues to benefit from institutional adoption through spot ETFs, with inflows driving price momentum and positioning it as a digital store of value akin to 'digital gold.' Its recent halving event has reduced new supply, historically a bullish catalyst. Ethereum, meanwhile, is transitioning through its post-merge identity shift — staking yields, Layer 2 ecosystem growth, and EIP-4844 blob transactions are reshaping its value proposition from 'world computer' to 'settlement layer for rollups.' ETH's price action has been more volatile, influenced by gas fee dynamics and DeFi activity cycles. Institutional interest in ETH is growing but lags behind Bitcoin's ETF-driven inflows. Both assets are sensitive to macro conditions — Fed rate expectations, dollar strength, and risk appetite drive short-term correlation."
user_visible_reasoning: "This is a comparison request, so PayLabs needs to find sources that analyze both Bitcoin and Ethereum — not just individual asset news. The run will search for market analysis, trend reports, and comparative research from crypto news outlets and financial analysis sources. It will cross-reference findings across multiple sources to build a balanced comparison. This runs the payment-decision phase to evaluate source quality and relevance, plus the creator payout phase for sources contributing to the analysis. Paid source unlock is not needed since market trend data is publicly available."
tier_decision_reason: "This is a comparison request classified as Normal tier because it requires cross-referencing multiple sources to build a balanced analysis of both Bitcoin and Ethereum. The entry x402 payment is processed, and the run also includes the payment-decision phase to evaluate source quality and relevance, plus the creator payout phase for sources contributing to the comparative analysis. Paid source unlock is not included since market trend data is publicly available."

Example 6 — Query: "Pay creator to unlock premium research report"
assistant_response: "This request involves paying a creator to access premium content, which requires the advanced route. PayLabs will first verify the source and evaluate whether the premium content justifies the unlock cost based on the creator's reputation and the content's relevance. Once you approve, it will unlock the premium source, attribute the creator, and route the eligible creator payout through the settlement layer using x402 micropayments. The answer will include only safe receipt and payment status fields — no raw transaction data or wallet details."
user_visible_reasoning: "This is an explicit paid source unlock request, so PayLabs runs the full pipeline. First, the payment-decision phase evaluates the source's value and trust. Then, if approved, the paid source unlock phase retrieves the premium content. The advanced evidence evaluation phase verifies the content quality before routing the creator payout. Finally, the creator payout phase attributes the creator and processes the micropayment settlement via x402. This is the most comprehensive tier — it handles discovery, evaluation, unlock, verification, and payout in sequence."
tier_decision_reason: "This is an explicit paid source unlock request classified as Advanced tier because it requires the full pipeline. The entry x402 payment is processed, and the run includes the payment-decision phase to evaluate source value, the paid source unlock phase to retrieve premium content, the advanced evidence evaluation phase to verify content quality, and the creator payout phase to attribute the creator and process settlement."
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
