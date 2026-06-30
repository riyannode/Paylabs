/**
 * Discovery Planner LangGraph
 *
 * Phase 1 of the delegated runtime.
 * Services: intent_planner → query_builder → signal_scout
 *
 * Graph: START → intent_planner → query_builder → signal_scout → build_summary → END
 *
 * Rules:
 * - LangGraph = internal execution orchestration ONLY
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Service nodes call callDelegatedService()
 * - Returns rankedCandidates + easy_summary
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { DiscoveryPlannerState, type DiscoveryPlannerStateType } from "../shared/state";
import { createServiceNode } from "../services/service-node";
import type { ServiceName } from "../../agent-services/types";
import type { BudgetSnapshot, SafeSourceCard } from "../../delegated-runtime/types";

// ─── Local Discovery Planner Service Presets ────────────────
// Single source of truth for discovery planner routing.
// TIER_SERVICE_PRESETS from quote-engine includes macro-node-level services
// (discovery_planner, payment_decision, settlement_memory) that are NOT
// graph-internal child services. These presets are graph-internal only.

// ─── Claim Status Normalization ────────────────────────────
// paylabs_feed_items uses 'claimed'/'unclaimed' (migration 12).
// Payout pipeline (claim-policy.ts) expects 'verified'/'unclaimed'.
// This normalizer bridges the two.

function normalizeClaimStatus(...statuses: unknown[]): string {
  for (const s of statuses) {
    if (s === "verified" || s === "claimed") return "verified";
    if (s && s !== "unclaimed" && s !== "null" && s !== "undefined") return String(s);
  }
  return "unclaimed";
}

const DISCOVERY_PLANNER_SERVICE_PRESETS: Record<string, ServiceName[]> = {
  easy: ["intent_planner", "query_builder", "signal_scout_basics"],
  normal: ["intent_planner", "query_builder", "signal_scout"],
  advanced: ["intent_planner", "query_builder", "signal_scout"],
};

// ─── Node: Intent Planner ───────────────────────────────────

const intentPlannerNode = createServiceNode(
  "intent_planner",
  "discovery_planner",
  (state) => ({
    goal: state.userGoal,
    budgetUsdc: state.userBudgetUsdc,
    routeTier: state.routeTier,
    brainNormalizedGoal: (state as DiscoveryPlannerStateType).brainNormalizedGoal,
    brainDiscoveryStrategy: (state as DiscoveryPlannerStateType).brainDiscoveryStrategy,
    brainSafeSummary: (state as DiscoveryPlannerStateType).brainSafeSummary,
  }),
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Query Builder ────────────────────────────────────

const queryBuilderNode = createServiceNode(
  "query_builder",
  "discovery_planner",
  (state) => ({
    // Use normalizedGoal from intent_planner result if available
    normalized_goal: (state as DiscoveryPlannerStateType).normalizedGoal || state.userGoal,
    topics: (state as DiscoveryPlannerStateType).constraints || [],
    routeTier: state.routeTier,
    brain_query_variants: (state as DiscoveryPlannerStateType).brainSuggestedQueryVariants || [],
    brain_discovery_strategy: (state as DiscoveryPlannerStateType).brainDiscoveryStrategy,
    brain_normalized_goal: (state as DiscoveryPlannerStateType).brainNormalizedGoal,
  }),
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Signal Scout ─────────────────────────────────────

const signalScoutNode = createServiceNode(
  "signal_scout",
  "discovery_planner",
  (state) => ({
    expanded_queries: (state as DiscoveryPlannerStateType).expandedQueries || [],
    entity_terms: (state as DiscoveryPlannerStateType).entityTerms || [],
    negative_filters: (state as DiscoveryPlannerStateType).negativeFilters || [],
    source_preferences: (state as DiscoveryPlannerStateType).sourcePreferences || [],
    routeTier: state.routeTier,
  }),
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: false, skipIfNotSelected: true }
);

// ─── Node: Signal Scout Basics (deterministic, easy tier) ──

const signalScoutBasicsNode = createServiceNode(
  "signal_scout_basics",
  "discovery_planner",
  (state) => ({
    expanded_queries: (state as DiscoveryPlannerStateType).expandedQueries || [],
    entity_terms: (state as DiscoveryPlannerStateType).entityTerms || [],
    negative_filters: (state as DiscoveryPlannerStateType).negativeFilters || [],
    source_preferences: (state as DiscoveryPlannerStateType).sourcePreferences || [],
    routeTier: state.routeTier,
  }),
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: false, skipIfNotSelected: true }
);

// ─── Node: Process Intent Result ────────────────────────────

async function processIntentResult(state: DiscoveryPlannerStateType) {
  // Extract intent planner output from the last service evaluation
  const evals = state.serviceEvaluations || [];
  const intentEval = evals.find((e) => e.serviceName === "intent_planner");

  if (!intentEval?.output) {
    return {
      normalizedGoal: state.userGoal,
      intentType: "unknown",
      constraints: [] as string[],
      routeTierHint: state.routeTier,
      progressSummaries: ["Intent planner returned no output — using defaults"],
    };
  }

  const data = intentEval.output as {
    normalized_goal?: string;
    intent_type?: string;
    constraints?: string[];
    route_tier_hint?: string;
  };

  return {
    normalizedGoal: data.normalized_goal || state.userGoal,
    intentType: data.intent_type || "unknown",
    constraints: data.constraints || [],
    routeTierHint: data.route_tier_hint || state.routeTier,
  };
}

// ─── Node: Process Query Result ─────────────────────────────

async function processQueryResult(state: DiscoveryPlannerStateType) {
  const evals = state.serviceEvaluations || [];
  const queryEval = evals.find((e) => e.serviceName === "query_builder");

  if (!queryEval?.output) {
    return {
      expandedQueries: [] as string[],
      entityTerms: [] as string[],
      progressSummaries: ["Query builder returned no output — using empty queries"],
    };
  }

  const data = queryEval.output as {
    expanded_queries?: string[];
    entity_terms?: string[];
    negative_filters?: string[];
    source_preferences?: string[];
  };

  return {
    expandedQueries: data.expanded_queries || [],
    entityTerms: data.entity_terms || [],
    negativeFilters: data.negative_filters || [],
    sourcePreferences: data.source_preferences || [],
  };
}

// ─── Node: Process Signal Result ────────────────────────────

async function processSignalResult(state: DiscoveryPlannerStateType) {
  const evals = state.serviceEvaluations || [];
  // Look for either signal_scout (rich) or signal_scout_basics (easy tier)
  // Prefer the one with actual output (completed), not a skipped entry
  const signalEval = evals.find((e: { serviceName: string; output: unknown }) =>
    (e.serviceName === "signal_scout" || e.serviceName === "signal_scout_basics") && e.output
  );

  if (!signalEval?.output) {
    return {
      rankedCandidates: [] as DiscoveryPlannerStateType["rankedCandidates"],
      topCandidates: [] as string[],
      progressSummaries: ["Signal scout returned no output — 0 candidates"],
    };
  }

  const data = signalEval.output as {
    ranked_candidates?: Array<{
      feed_item_id: string;
      title: string;
      publisher: string;
      source_kind?: string;
      provider?: string;
      source_url?: string;
      domain?: string | null;
      summary?: string;
      author?: string;
      published_at?: string | null;
      route_path?: string;
      rsshub_feed_url?: string | null;
      docs_url?: string | null;
      reason?: string;
      rank: number;
      relevance_score: number;
    }>;
    top_candidates?: string[];
    retrieval_mode?: string;
  };

  return {
    rankedCandidates: data.ranked_candidates || [],
    topCandidates: data.top_candidates || [],
    retrievalMode: data.retrieval_mode || undefined,
  };
}

// ─── Node: Build Easy Summary ───────────────────────────────

async function buildEasySummary(state: DiscoveryPlannerStateType) {
  const candidates = state.rankedCandidates || [];
  const normalizedGoal = state.normalizedGoal || state.userGoal;
  const intentType = state.intentType || "unknown";

  const summary = `Discovery Planner: ${candidates.length} candidates found. ` +
    `Goal: "${normalizedGoal.slice(0, 80)}". ` +
    `Intent: ${intentType}. ` +
    `3 services executed.`;

  return {
    progressSummaries: [summary],
  };
}

// ─── Graph Wiring ───────────────────────────────────────────

const graph = new StateGraph(DiscoveryPlannerState)
  // Service nodes
  .addNode("intent_planner", intentPlannerNode)
  .addNode("process_intent", processIntentResult)
  .addNode("query_builder", queryBuilderNode)
  .addNode("process_query", processQueryResult)
  .addNode("signal_scout", signalScoutNode)
  .addNode("signal_scout_basics", signalScoutBasicsNode)
  .addNode("process_signal", processSignalResult)
  .addNode("build_summary", buildEasySummary)
  // Edges
  .addEdge(START, "intent_planner")
  .addEdge("intent_planner", "process_intent")
  .addEdge("process_intent", "query_builder")
  .addEdge("query_builder", "process_query")
  .addConditionalEdges("process_query", (state: DiscoveryPlannerStateType) => {
    // Deterministic routing: use routeTier, NOT selectedServices
    // selectedServices may be empty or corrupted by concatReducer in some code paths
    const routeTier = (state.routeTier as string) || "easy";
    const presets = DISCOVERY_PLANNER_SERVICE_PRESETS[routeTier] || DISCOVERY_PLANNER_SERVICE_PRESETS.easy;
    const nextScoutNode: string = presets.includes("signal_scout_basics") ? "signal_scout_basics" : "signal_scout";

    // Safe production diagnostic (no secrets)
    console.log(JSON.stringify({
      log: "[discovery-planner-route]",
      discoveryRunId: state.discoveryRunId,
      routeTier,
      selectedServices: presets,
      nextScoutNode,
    }));

    return nextScoutNode;
  }, ["signal_scout", "signal_scout_basics"])
  .addEdge("signal_scout", "process_signal")
  .addEdge("signal_scout_basics", "process_signal")
  .addEdge("process_signal", "build_summary")
  .addEdge("build_summary", END)
  .compile();

// ─── Public API ─────────────────────────────────────────────

export interface RunDiscoveryPlannerGraphInput {
  discoveryRunId: string;
  userGoal: string;
  routeTier: "easy" | "normal" | "advanced";
  userBudgetUsdc: number;
  selectedServices?: ServiceName[];
  parentWalletId?: string;
  brainNormalizedGoal?: string;
  brainDiscoveryStrategy?: string;
  brainSuggestedQueryVariants?: string[];
  brainSafeSummary?: string;
}

export interface RunDiscoveryPlannerGraphOutput {
  ok: boolean;
  rankedCandidates: Array<{
    feed_item_id: string;
    title: string;
    publisher: string;
    source_kind?: string;
    provider?: string;
    source_url?: string;
    domain?: string | null;
    summary?: string;
    author?: string;
    published_at?: string | null;
    route_path?: string;
    rsshub_feed_url?: string | null;
    docs_url?: string | null;
    reason?: string;
    rank: number;
    relevance_score: number;
  }>;
  normalizedGoal: string;
  sourceCards: SafeSourceCard[];
  easySummary: string;
  serviceEvaluations: DiscoveryPlannerStateType["serviceEvaluations"];
  paymentEdges: DiscoveryPlannerStateType["paymentEdges"];
  progressSummaries: string[];
  retrievalMode?: string;
  entityTerms?: string[];
  expandedQueries?: string[];
  negativeFilters?: string[];
  sourcePreferences?: string[];
  error: string | null;
}

/**
 * Run the Discovery Planner graph (replaces plain async runner).
 */
export async function runDiscoveryPlannerGraph(
  input: RunDiscoveryPlannerGraphInput
): Promise<RunDiscoveryPlannerGraphOutput> {
  const initialBudget: BudgetSnapshot = {
    totalBudgetUsdc: input.userBudgetUsdc,
    spentUsdc: 0,
    remainingUsdc: input.userBudgetUsdc,
    serviceSpend: {} as Record<ServiceName, number>,
    settledServiceFeesUsdc: 0,
    estimatedServiceFeesUsdc: 0,
  };

  try {
    const result = await graph.invoke({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      // Always use local discovery planner presets — never trust caller-selectedServices
      // for internal graph routing. Caller-selectedServices may be empty, incomplete,
      // or corrupted by concatReducer in upstream code paths.
      selectedServices: DISCOVERY_PLANNER_SERVICE_PRESETS[input.routeTier] || DISCOVERY_PLANNER_SERVICE_PRESETS.easy,
      parentWalletId: input.parentWalletId,
      budgetSnapshot: initialBudget,
      // Brain planning pass-through
      brainNormalizedGoal: input.brainNormalizedGoal,
      brainDiscoveryStrategy: input.brainDiscoveryStrategy,
      brainSuggestedQueryVariants: input.brainSuggestedQueryVariants || [],
      brainSafeSummary: input.brainSafeSummary,
      // Initialize arrays
      constraints: [],
      expandedQueries: [],
      entityTerms: [],
      rankedCandidates: [],
      topCandidates: [],
      negativeFilters: [],
      sourcePreferences: [],
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [],
    });

    // Build easy_summary from progress summaries
    const easySummary = `Discovery Planner: ${result.rankedCandidates?.length || 0} candidates. ` +
      `Goal: "${(result.normalizedGoal || input.userGoal).slice(0, 80)}". ` +
      `Intent: ${result.intentType || "unknown"}. 3 services executed.`;

    // Compute normalizedGoal: graph result → brain input → user input
    const normalizedGoal = result.normalizedGoal || input.brainNormalizedGoal || input.userGoal;

    // Build safe source cards from ranked candidates
    // Live candidates: build directly from candidate fields (no DB lookup)
    // DB candidates: enrich via getFeedItemById
    const rankedCandidates = result.rankedCandidates || [];
    const sourceCards: SafeSourceCard[] = [];
    const maxSourceCards = Number(process.env.PAYLABS_SOURCE_CONTEXT_MAX_SOURCES) || 20;

    // Collect live source URLs for batch claim resolution
    const liveSourceUrls: string[] = [];
    for (const candidate of rankedCandidates.slice(0, maxSourceCards)) {
      if (candidate.source_kind === "rsshub_live" || candidate.source_kind === "tavily_live") {
        if (candidate.source_url) liveSourceUrls.push(candidate.source_url);
      }
    }

    // Batch resolve claims for live sources
    let liveClaimsMap: Map<string, { creator_wallet: string; claim_id: string } | null> = new Map();
    if (liveSourceUrls.length > 0) {
      try {
        const { resolveCreatorClaimsBatch } = await import("../../creator-distribution/claim-resolver");
        const resolved = await resolveCreatorClaimsBatch(liveSourceUrls);
        for (const [url, claim] of resolved) {
          liveClaimsMap.set(url, claim ? { creator_wallet: claim.creator_wallet, claim_id: claim.claim_id } : null);
        }
      } catch {
        // Resolver failure should not block discovery
      }
    }

    for (const candidate of rankedCandidates.slice(0, maxSourceCards)) {
      // Live candidate: has source_url directly
      if (candidate.source_kind === "rsshub_live" || candidate.source_kind === "tavily_live") {
        const resolvedClaim = candidate.source_url ? liveClaimsMap.get(candidate.source_url) : null;
        sourceCards.push({
          feed_item_id: candidate.feed_item_id,
          title: candidate.title || "",
          source_url: candidate.source_url || "",
          publisher: candidate.publisher || "",
          claim_status: resolvedClaim ? "verified" : "unclaimed",
          creator_wallet: resolvedClaim?.creator_wallet || null,
          source_kind: candidate.source_kind,
          provider: candidate.provider,
        });
      } else {
        // DB candidate: enrich via getFeedItemById
        const { getFeedItemById } = await import("../../../ai/tools");
        const feedItem = (await getFeedItemById(candidate.feed_item_id)) as Record<string, unknown> | null;
        sourceCards.push({
          feed_item_id: candidate.feed_item_id,
          title: String(feedItem?.title || candidate.title || ""),
          source_url: String(feedItem?.canonical_url || ""),
          publisher: String(feedItem?.publisher || candidate.publisher || ""),
          // Normalize: paylabs_feed_items uses 'claimed', payout pipeline uses 'verified'
          claim_status: normalizeClaimStatus(feedItem?.claim_status, feedItem?.verification_status),
          creator_wallet: feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : null,
        });
      }
    }

    return {
      ok: !result.error,
      rankedCandidates,
      normalizedGoal,
      sourceCards,
      easySummary,
      serviceEvaluations: result.serviceEvaluations || [],
      paymentEdges: result.paymentEdges || [],
      progressSummaries: result.progressSummaries || [],
      retrievalMode: result.retrievalMode,
      entityTerms: result.entityTerms || [],
      expandedQueries: result.expandedQueries || [],
      negativeFilters: result.negativeFilters || [],
      sourcePreferences: result.sourcePreferences || [],
      error: result.error || null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      rankedCandidates: [],
      normalizedGoal: input.brainNormalizedGoal || input.userGoal,
      sourceCards: [],
      easySummary: `Discovery Planner failed: ${msg}`,
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [`Discovery Planner graph error: ${msg}`],
      retrievalMode: undefined,
      error: msg,
    };
  }
}
