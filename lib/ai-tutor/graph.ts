/**
 * PayLabs Tutor LangGraph Workflow
 *
 * Two separate graphs:
 * 1. proposeSourcePath: START -> intent -> source_planner -> source_verifier -> persist -> END
 * 2. executeSourcePayment: START -> policy_guard -> payment_executor -> END
 *
 * Proposal and payment are separate invocations.
 * Payment is impossible until the user approves the source path.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { PayLabsTutorState } from "./state";
import type { PayLabsTutorStateType } from "./state";
import { intentAgent } from "./intent-agent";
import { sourcePlannerAgent } from "./source-planner-agent";
import { sourceVerifierAgent } from "./source-verifier-agent";
import { policyGuardAgent } from "./policy-guard-agent";
import { paymentExecutorAgent } from "./payment-executor-agent";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";

// ─── Persist Proposed Source Path Node ───────────────────────────

async function persistProposedSourcePathNode(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, goal, budgetUsdc, verifiedSources, estimatedTotalUsdc, allVerified, routeTier, routeConfig, agentTrace, llmOutputs, llmErrors, agentServiceCalls } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = routeConfig || getRouteConfig(tier);

  if (!allVerified || !verifiedSources || verifiedSources.length === 0) {
    return {
      error: "Cannot persist: no verified sources",
      sourcePathStatus: "none",
    };
  }

  try {
    // Insert source path — persist route_tier, route_config, agent_trace
    const fullAgentTrace = {
      ...(agentTrace || {}),
      ...(llmOutputs && Object.keys(llmOutputs).length > 0 ? { llm_outputs: llmOutputs } : {}),
      ...(llmErrors && Object.keys(llmErrors).length > 0 ? { llm_errors: llmErrors } : {}),
      ...(agentServiceCalls && agentServiceCalls.length > 0 ? { agent_service_calls: agentServiceCalls } : {}),
    };

    const { data: pathRow, error: pathErr } = await supabaseAdmin()
      .from("paylabs_source_paths")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        goal: goal || "",
        budget_usdc: budgetUsdc || 0,
        estimated_total_usdc: estimatedTotalUsdc || 0,
        agent_reasoning_summary: `LangGraph verified ${verifiedSources.length} sources for goal: ${(goal || "").slice(0, 100)}`,
        status: "proposed",
        created_by_agent_id: "paylabs-langgraph-v1",
        route_tier: tier,
        route_config: config,
        agent_trace: fullAgentTrace,
      })
      .select("id, status")
      .single();

    if (pathErr || !pathRow) {
      return {
        error: `Failed to create source path: ${pathErr?.message}`,
        sourcePathStatus: "none",
      };
    }

    // Insert source path items
    const pathItems = (verifiedSources as Record<string, unknown>[]).map((v, i) => ({
      source_path_id: pathRow.id,
      feed_item_id: v.feed_item_id as string,
      order_index: i,
      reason: v.verification_reason as string,
      expected_value: `Verified RSSHub source`,
      status: "proposed",
    }));

    const { error: itemsErr } = await supabaseAdmin()
      .from("paylabs_source_path_items")
      .insert(pathItems);

    if (itemsErr) {
      // Clean up path if items fail
      await supabaseAdmin()
        .from("paylabs_source_paths")
        .delete()
        .eq("id", pathRow.id);
      return {
        error: `Failed to create source path items: ${itemsErr.message}`,
        sourcePathStatus: "none",
      };
    }

    return {
      sourcePathId: pathRow.id,
      sourcePathStatus: "proposed",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Persist failed: ${msg}`, sourcePathStatus: "none" };
  }
}

// ─── Proposal Graph ──────────────────────────────────────────────

const proposalGraph = new StateGraph(PayLabsTutorState)
  .addNode("intent_agent", intentAgent)
  .addNode("source_planner_agent", sourcePlannerAgent)
  .addNode("source_verifier_agent", sourceVerifierAgent)
  .addNode("persist_proposed_source_path", persistProposedSourcePathNode)
  .addEdge(START, "intent_agent")
  .addEdge("intent_agent", "source_planner_agent")
  .addEdge("source_planner_agent", "source_verifier_agent")
  .addEdge("source_verifier_agent", "persist_proposed_source_path")
  .addEdge("persist_proposed_source_path", END)
  .compile();

// ─── Source Payment Graph ────────────────────────────────────────

const sourcePaymentGraph = new StateGraph(PayLabsTutorState)
  .addNode("policy_guard_agent", policyGuardAgent)
  .addNode("payment_executor_agent", paymentExecutorAgent)
  .addEdge(START, "policy_guard_agent")
  .addEdge("policy_guard_agent", "payment_executor_agent")
  .addEdge("payment_executor_agent", END)
  .compile();

// ─── Public API ──────────────────────────────────────────────────

export async function proposeSourcePath(input: {
  userWallet: string;
  goal: string;
  budgetUsdc: number;
  routeTier?: RouteTier;
}) {
  const tier: RouteTier = input.routeTier || "normal";
  const config = getRouteConfig(tier);
  const prompts = getPromptsForRoute(tier);

  const result = await proposalGraph.invoke({
    userWallet: input.userWallet,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    routeTier: tier,
    routeConfig: config as unknown as Record<string, unknown>,
    routePrompts: prompts as unknown as Record<string, unknown>,
    agentTrace: {},
    topics: [],
    riskNotes: [],
    sourcePathStatus: "none" as const,
    availableFeedItems: [],
    paidSourceIds: [],
    selectedSources: [],
    plannerNotes: [],
    verifiedSources: [],
    rejectedSources: [],
  } as unknown as PayLabsTutorStateType);

  return {
    sourcePathId: result.sourcePathId,
    sourcePathStatus: result.sourcePathStatus,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    routeTier: tier,
    routeConfig: config,
    selectedSources: result.selectedSources,
    verifiedSources: result.verifiedSources,
    rejectedSources: result.rejectedSources,
    estimatedTotalUsdc: result.estimatedTotalUsdc,
    remainingUsdc: result.remainingUsdc,
    agentServiceCalls: result.agentServiceCalls || [],
    error: result.error,
  };
}

export async function executeSourcePayment(input: {
  userWallet: string;
  sourcePathId: string;
  sourcePathItemId: string;
}) {
  // Fetch source path to get actual route_tier
  const { data: pathRow } = await supabaseAdmin()
    .from("paylabs_source_paths")
    .select("route_tier, route_config, agent_trace")
    .eq("id", input.sourcePathId)
    .single();

  const tier: RouteTier = (pathRow?.route_tier as RouteTier) || "normal";
  const config = pathRow?.route_config || getRouteConfig(tier);
  const prompts = getPromptsForRoute(tier);

  // Payment graph does NOT change behavior by tier — same safety for all routes
  const result = await sourcePaymentGraph.invoke({
    userWallet: input.userWallet,
    sourcePathId: input.sourcePathId,
    sourcePathItemId: input.sourcePathItemId,
    routeTier: tier,
    routeConfig: config as Record<string, unknown>,
    routePrompts: prompts as unknown as Record<string, unknown>,
    topics: [],
    riskNotes: [],
    sourcePathStatus: "none" as const,
    availableFeedItems: [],
    paidSourceIds: [],
    selectedSources: [],
    plannerNotes: [],
    verifiedSources: [],
    rejectedSources: [],
  } as unknown as PayLabsTutorStateType);

  return {
    allowed: result.policyDecision?.allowed,
    sourcePaymentId: result.sourcePaymentId,
    receiptId: result.receiptId,
    runnerPaymentResult: result.runnerPaymentResult,
    error: result.error,
    policyDecision: result.policyDecision,
  };
}
