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
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
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
  const signalEval = evals.find((e) => e.serviceName === "signal_scout");

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
      rank: number;
      relevance_score: number;
    }>;
    top_candidates?: string[];
  };

  return {
    rankedCandidates: data.ranked_candidates || [],
    topCandidates: data.top_candidates || [],
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
  .addNode("process_signal", processSignalResult)
  .addNode("build_summary", buildEasySummary)
  // Edges
  .addEdge(START, "intent_planner")
  .addEdge("intent_planner", "process_intent")
  .addEdge("process_intent", "query_builder")
  .addEdge("query_builder", "process_query")
  .addEdge("process_query", "signal_scout")
  .addEdge("signal_scout", "process_signal")
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
    rank: number;
    relevance_score: number;
  }>;
  normalizedGoal: string;
  sourceCards: SafeSourceCard[];
  easySummary: string;
  serviceEvaluations: DiscoveryPlannerStateType["serviceEvaluations"];
  paymentEdges: DiscoveryPlannerStateType["paymentEdges"];
  progressSummaries: string[];
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
      selectedServices: input.selectedServices || [],
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

    // Build safe source cards from top 10 ranked candidates
    const rankedCandidates = result.rankedCandidates || [];
    const sourceCards: SafeSourceCard[] = [];
    const { getFeedItemById } = await import("../../../ai/tools");
    for (const candidate of rankedCandidates.slice(0, 10)) {
      const feedItem = (await getFeedItemById(candidate.feed_item_id)) as Record<string, unknown> | null;
      sourceCards.push({
        feed_item_id: candidate.feed_item_id,
        title: String(feedItem?.title || candidate.title || ""),
        source_url: String(feedItem?.canonical_url || ""),
        publisher: String(feedItem?.publisher || candidate.publisher || ""),
        claim_status: String(feedItem?.verification_status || "unclaimed"),
        creator_wallet: feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : null,
      });
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
      error: msg,
    };
  }
}
