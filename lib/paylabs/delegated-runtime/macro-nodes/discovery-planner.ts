/**
 * Discovery Planner Macro-Node
 *
 * Phase 1 of the delegated runtime.
 * Services: intent_planner → query_builder → signal_scout → intent_matcher
 *
 * This phase:
 * 1. Classifies user intent and normalizes the goal
 * 2. Expands goal into discovery queries
 * 3. Discovers and ranks candidate sources
 * 4. Matches candidates against intent
 */

import type { OrchestratorRunState } from "../types";
import type { ServiceHandlerInput, ServiceHandlerOutput, ServiceName } from "../../agent-services/types";
import { SERVICE_HANDLERS } from "../../agent-services/handlers";
import { addServiceEvaluation, updateBudgetSnapshot, addProgressSummary } from "../state";

// ─── Services in this phase ──────────────────────────────────
const PHASE_SERVICES: ServiceName[] = [
  "intent_planner",
  "query_builder",
  "signal_scout",
  "intent_matcher",
];

// ─── Run Discovery Planner ───────────────────────────────────

export async function runDiscoveryPlanner(
  state: OrchestratorRunState
): Promise<{
  ok: boolean;
  normalizedGoal: string | null;
  intentType: string | null;
  constraints: string[];
  routeTierHint: string;
  rankedCandidates: Array<{
    feed_item_id: string;
    title: string;
    publisher: string;
    rank: number;
    relevance_score: number;
  }>;
  approvedForQualityCheck: boolean;
  error: string | null;
}> {
  // ── Step 1: Intent Planner ──
  const intentInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "intent_planner",
    payload: {
      goal: state.userGoal,
      budgetUsdc: state.userBudgetUsdc,
      routeTier: state.routeTier,
    },
  };

  const intentResult = await SERVICE_HANDLERS.intent_planner(intentInput);
  addServiceEvaluation(state, {
    serviceName: "intent_planner",
    macroNode: "discovery_planner",
    input: intentInput.payload,
    output: intentResult.data,
    safeSummary: intentResult.safeSummary,
    status: intentResult.ok ? "completed" : "failed",
    costUsdc: 0.000001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: intentResult.error,
  });
  updateBudgetSnapshot(state, "intent_planner", 0.000001);

  if (!intentResult.ok || !intentResult.data) {
    return {
      ok: false,
      normalizedGoal: null,
      intentType: null,
      constraints: [],
      routeTierHint: state.routeTier,
      rankedCandidates: [],
      approvedForQualityCheck: false,
      error: `Intent planner failed: ${intentResult.error}`,
    };
  }

  const intentData = intentResult.data as {
    normalized_goal: string;
    intent_type: string;
    constraints: string[];
    route_tier_hint: string;
  };

  // ── Step 2: Query Builder ──
  const queryInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "query_builder",
    payload: {
      normalized_goal: intentData.normalized_goal,
      topics: intentData.constraints,
      routeTier: state.routeTier,
    },
  };

  const queryResult = await SERVICE_HANDLERS.query_builder(queryInput);
  addServiceEvaluation(state, {
    serviceName: "query_builder",
    macroNode: "discovery_planner",
    input: queryInput.payload,
    output: queryResult.data,
    safeSummary: queryResult.safeSummary,
    status: queryResult.ok ? "completed" : "failed",
    costUsdc: 0.000001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: queryResult.error,
  });
  updateBudgetSnapshot(state, "query_builder", 0.000001);

  if (!queryResult.ok || !queryResult.data) {
    return {
      ok: false,
      normalizedGoal: intentData.normalized_goal,
      intentType: intentData.intent_type,
      constraints: intentData.constraints,
      routeTierHint: intentData.route_tier_hint,
      rankedCandidates: [],
      approvedForQualityCheck: false,
      error: `Query builder failed: ${queryResult.error}`,
    };
  }

  const queryData = queryResult.data as {
    expanded_queries: string[];
    entity_terms: string[];
  };

  // ── Step 3: Signal Scout ──
  const signalInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "signal_scout",
    payload: {
      expanded_queries: queryData.expanded_queries,
      entity_terms: queryData.entity_terms,
      routeTier: state.routeTier,
    },
  };

  const signalResult = await SERVICE_HANDLERS.signal_scout(signalInput);
  addServiceEvaluation(state, {
    serviceName: "signal_scout",
    macroNode: "discovery_planner",
    input: signalInput.payload,
    output: signalResult.data,
    safeSummary: signalResult.safeSummary,
    status: signalResult.ok ? "completed" : "failed",
    costUsdc: 0.000001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: signalResult.error,
  });
  updateBudgetSnapshot(state, "signal_scout", 0.000001);

  if (!signalResult.ok || !signalResult.data) {
    return {
      ok: false,
      normalizedGoal: intentData.normalized_goal,
      intentType: intentData.intent_type,
      constraints: intentData.constraints,
      routeTierHint: intentData.route_tier_hint,
      rankedCandidates: [],
      approvedForQualityCheck: false,
      error: `Signal scout failed: ${signalResult.error}`,
    };
  }

  const signalData = signalResult.data as {
    ranked_candidates: Array<{
      feed_item_id: string;
      title: string;
      publisher: string;
      rank: number;
      relevance_score: number;
    }>;
    top_candidates: string[];
  };

  // ── Step 4: Intent Matcher ──
  const matcherInput: ServiceHandlerInput = {
    discoveryRunId: state.discoveryRunId,
    serviceName: "intent_matcher",
    payload: {
      normalized_goal: intentData.normalized_goal,
      candidates: signalData.ranked_candidates.slice(0, 10), // top 10
      routeTier: state.routeTier,
    },
  };

  const matcherResult = await SERVICE_HANDLERS.intent_matcher(matcherInput);
  addServiceEvaluation(state, {
    serviceName: "intent_matcher",
    macroNode: "discovery_planner",
    input: matcherInput.payload,
    output: matcherResult.data,
    safeSummary: matcherResult.safeSummary,
    status: matcherResult.ok ? "completed" : "failed",
    costUsdc: 0.000001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: matcherResult.error,
  });
  updateBudgetSnapshot(state, "intent_matcher", 0.000001);

  const matcherData = matcherResult.data as {
    approved_for_quality_check: boolean;
  } | null;

  const summary = `Discovery Planner: ${signalData.ranked_candidates.length} candidates ranked, ${signalData.top_candidates.length} top candidates, intent match: ${matcherData?.approved_for_quality_check ? "approved" : "not approved"}.`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    normalizedGoal: intentData.normalized_goal,
    intentType: intentData.intent_type,
    constraints: intentData.constraints,
    routeTierHint: intentData.route_tier_hint,
    rankedCandidates: signalData.ranked_candidates,
    approvedForQualityCheck: matcherData?.approved_for_quality_check ?? false,
    error: null,
  };
}
