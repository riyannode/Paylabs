/**
 * Discovery Planner Macro-Node
 *
 * Phase 1 of the delegated runtime.
 * Services: intent_planner → query_builder → signal_scout
 *
 * This phase:
 * 1. Classifies user intent and normalizes the goal
 * 2. Expands goal into discovery queries
 * 3. Discovers and ranks candidate sources
 *
 * All calls go through callDelegatedService() (edge + schema validation).
 * Edge chain: run_budget_controller → intent_planner → query_builder → signal_scout
 */

import type { OrchestratorRunState } from "../types";
import { callDelegatedService } from "../../agent-services/call-delegated-service";
import { addServiceEvaluation, updateBudgetSnapshot, addProgressSummary } from "../state";

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
  error: string | null;
}> {
  // ── Step 1: Intent Planner ──
  // Edge: run_budget_controller → intent_planner
  const intentResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "run_budget_controller",
    sellerServiceName: "intent_planner",
    payload: {
      goal: state.userGoal,
      budgetUsdc: state.userBudgetUsdc,
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "intent_planner",
    macroNode: "discovery_planner",
    input: { goal: state.userGoal },
    output: intentResult.data,
    safeSummary: intentResult.safeSummary,
    status: intentResult.ok ? "completed" : "failed",
    costUsdc: intentResult.safeCallMeta.costUsdc,
    startedAt: intentResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: intentResult.error,
  });
  updateBudgetSnapshot(state, "intent_planner", intentResult.safeCallMeta.costUsdc);

  if (!intentResult.ok || !intentResult.data) {
    return {
      ok: false,
      normalizedGoal: null,
      intentType: null,
      constraints: [],
      routeTierHint: state.routeTier,
      rankedCandidates: [],
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
  // Edge: intent_planner → query_builder
  const queryResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "intent_planner",
    sellerServiceName: "query_builder",
    payload: {
      normalized_goal: intentData.normalized_goal,
      topics: intentData.constraints,
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "query_builder",
    macroNode: "discovery_planner",
    input: { normalized_goal: intentData.normalized_goal },
    output: queryResult.data,
    safeSummary: queryResult.safeSummary,
    status: queryResult.ok ? "completed" : "failed",
    costUsdc: queryResult.safeCallMeta.costUsdc,
    startedAt: queryResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: queryResult.error,
  });
  updateBudgetSnapshot(state, "query_builder", queryResult.safeCallMeta.costUsdc);

  if (!queryResult.ok || !queryResult.data) {
    return {
      ok: false,
      normalizedGoal: intentData.normalized_goal,
      intentType: intentData.intent_type,
      constraints: intentData.constraints,
      routeTierHint: intentData.route_tier_hint,
      rankedCandidates: [],
      error: `Query builder failed: ${queryResult.error}`,
    };
  }

  const queryData = queryResult.data as {
    expanded_queries: string[];
    entity_terms: string[];
  };

  // ── Step 3: Signal Scout ──
  // Edge: query_builder → signal_scout
  const signalResult = await callDelegatedService({
    discoveryRunId: state.discoveryRunId,
    buyerAgentName: "query_builder",
    sellerServiceName: "signal_scout",
    payload: {
      expanded_queries: queryData.expanded_queries,
      entity_terms: queryData.entity_terms,
      routeTier: state.routeTier,
    },
  });

  addServiceEvaluation(state, {
    serviceName: "signal_scout",
    macroNode: "discovery_planner",
    input: { query_count: queryData.expanded_queries.length },
    output: signalResult.data,
    safeSummary: signalResult.safeSummary,
    status: signalResult.ok ? "completed" : "failed",
    costUsdc: signalResult.safeCallMeta.costUsdc,
    startedAt: signalResult.safeCallMeta.timestamp,
    completedAt: new Date().toISOString(),
    error: signalResult.error,
  });
  updateBudgetSnapshot(state, "signal_scout", signalResult.safeCallMeta.costUsdc);

  if (!signalResult.ok || !signalResult.data) {
    return {
      ok: false,
      normalizedGoal: intentData.normalized_goal,
      intentType: intentData.intent_type,
      constraints: intentData.constraints,
      routeTierHint: intentData.route_tier_hint,
      rankedCandidates: [],
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

  const summary = `Discovery Planner: ${signalData.ranked_candidates.length} candidates ranked, ${signalData.top_candidates.length} top candidates. 3 service calls (chain).`;
  addProgressSummary(state, summary);

  return {
    ok: true,
    normalizedGoal: intentData.normalized_goal,
    intentType: intentData.intent_type,
    constraints: intentData.constraints,
    routeTierHint: intentData.route_tier_hint,
    rankedCandidates: signalData.ranked_candidates,
    error: null,
  };
}
