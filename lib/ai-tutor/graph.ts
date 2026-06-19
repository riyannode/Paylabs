/**
 * PayLabs Tutor LangGraph Workflow
 *
 * Two separate graphs:
 * 1. proposeLearningPath: START -> intent -> curriculum_planner -> source_verifier -> persist -> END
 * 2. buyApprovedLesson: START -> policy_guard -> payment_executor -> END
 *
 * Proposal and buying are separate invocations.
 * Buying is impossible until the user approves the path.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { PayLabsTutorState } from "./state";
import type { PayLabsTutorStateType } from "./state";
import { intentAgent } from "./intent-agent";
import { curriculumPlannerAgent } from "./curriculum-planner-agent";
import { sourceVerifierAgent } from "./source-verifier-agent";
import { policyGuardAgent } from "./policy-guard-agent";
import { paymentReceiptExecutorAgent } from "./payment-receipt-executor-agent";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";

// ─── Persist Proposed Path Node ──────────────────────────────────

async function persistProposedPathNode(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, goal, budgetUsdc, verifiedLessons, verifiedFeedItems, rejectedFeedItems, selectedFeedItems, estimatedTotalUsdc, sourcePathTotalUsdc, sourceCardCount, allVerified, routeTier, routeConfig, agentTrace, llmOutputs, llmErrors, agentServiceCalls } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = (routeConfig as unknown as ReturnType<typeof getRouteConfig>) || getRouteConfig(tier);

  // ── RSSHub Source Path ──
  if (verifiedFeedItems && (verifiedFeedItems as Record<string, unknown>[]).length > 0) {
    return await persistSourcePath({
      userWallet,
      goal: goal || "",
      budgetUsdc: budgetUsdc || 0,
      verifiedFeedItems: verifiedFeedItems as Record<string, unknown>[],
      rejectedFeedItems: (rejectedFeedItems || []) as Record<string, unknown>[],
      selectedFeedItems: (selectedFeedItems || []) as Record<string, unknown>[],
      sourcePathTotalUsdc: sourcePathTotalUsdc || 0,
      sourceCardCount: sourceCardCount || 0,
      allVerified: allVerified || false,
      tier,
      config,
      agentTrace: agentTrace || {},
      llmOutputs: llmOutputs || {},
      llmErrors: llmErrors || {},
      agentServiceCalls: agentServiceCalls || [],
    });
  }

  // ── Legacy Lesson Path ──
  if (!allVerified || !verifiedLessons || verifiedLessons.length === 0) {
    return {
      error: "Cannot persist: no verified lessons or feed items",
      pathStatus: "none",
    };
  }

  try {
    // Insert learning path — persist route_tier, route_config, agent_trace (includes LLM data)
    const fullAgentTrace = {
      ...(agentTrace || {}),
      ...(llmOutputs && Object.keys(llmOutputs).length > 0 ? { llm_outputs: llmOutputs } : {}),
      ...(llmErrors && Object.keys(llmErrors).length > 0 ? { llm_errors: llmErrors } : {}),
      ...(agentServiceCalls && agentServiceCalls.length > 0 ? { agent_service_calls: agentServiceCalls } : {}),
    };

    const { data: pathRow, error: pathErr } = await supabaseAdmin()
      .from("paylabs_learning_paths")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        goal: goal || "",
        budget_usdc: budgetUsdc || 0,
        estimated_total_usdc: estimatedTotalUsdc || 0,
        agent_reasoning_summary: `5-agent LangGraph verified ${verifiedLessons.length} lessons for goal: ${(goal || "").slice(0, 100)}`,
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
        error: `Failed to create path: ${pathErr?.message}`,
        pathStatus: "none",
      };
    }

    // Insert path items
    const pathItems = (verifiedLessons as Record<string, unknown>[]).map((v, i) => ({
      path_id: pathRow.id,
      lesson_id: v.lesson_id as string,
      order_index: i,
      reason: v.verification_reason as string,
      expected_value: `Learn from verified source`,
      status: "proposed",
    }));

    const { error: itemsErr } = await supabaseAdmin()
      .from("paylabs_learning_path_items")
      .insert(pathItems);

    if (itemsErr) {
      // Clean up path if items fail
      await supabaseAdmin()
        .from("paylabs_learning_paths")
        .delete()
        .eq("id", pathRow.id);
      return {
        error: `Failed to create path items: ${itemsErr.message}`,
        pathStatus: "none",
      };
    }

    return {
      pathId: pathRow.id,
      pathStatus: "proposed",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Persist failed: ${msg}`, pathStatus: "none" };
  }
}

// ─── Persist RSSHub Source Path ──────────────────────────────────

async function persistSourcePath(input: {
  userWallet: string;
  goal: string;
  budgetUsdc: number;
  verifiedFeedItems: Record<string, unknown>[];
  rejectedFeedItems: Record<string, unknown>[];
  selectedFeedItems: Record<string, unknown>[];
  sourcePathTotalUsdc: number;
  sourceCardCount: number;
  allVerified: boolean;
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  agentTrace: Record<string, unknown>;
  llmOutputs: Record<string, unknown>;
  llmErrors: Record<string, unknown>;
  agentServiceCalls: Record<string, unknown>[];
}): Promise<Partial<PayLabsTutorStateType>> {
  const {
    userWallet,
    goal,
    budgetUsdc,
    verifiedFeedItems,
    rejectedFeedItems,
    selectedFeedItems,
    sourcePathTotalUsdc,
    sourceCardCount,
    allVerified,
    tier,
    config,
    agentTrace,
    llmOutputs,
    llmErrors,
    agentServiceCalls,
  } = input;

  if (!allVerified || rejectedFeedItems.length > 0) {
    return {
      error: "Cannot persist: not all feed items verified",
      pathStatus: "none",
    };
  }

  if (verifiedFeedItems.length === 0) {
    return {
      error: "Cannot persist: no verified feed items",
      pathStatus: "none",
    };
  }

  try {
    const fullAgentTrace = {
      ...agentTrace,
      ...(Object.keys(llmOutputs).length > 0 ? { llm_outputs: llmOutputs } : {}),
      ...(Object.keys(llmErrors).length > 0 ? { llm_errors: llmErrors } : {}),
      ...(agentServiceCalls.length > 0 ? { agent_service_calls: agentServiceCalls } : {}),
      selected_feed_items: selectedFeedItems,
      verified_feed_items: verifiedFeedItems,
      rejected_feed_items: rejectedFeedItems,
    };

    const { data: pathRow, error: pathErr } = await supabaseAdmin()
      .from("paylabs_learning_paths")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        goal,
        budget_usdc: budgetUsdc,
        estimated_total_usdc: sourcePathTotalUsdc,
        agent_reasoning_summary: `LangGraph proposed ${sourceCardCount} RSSHub source cards for goal: ${goal.slice(0, 100)}`,
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
        pathStatus: "none",
      };
    }

    // Insert source path items
    const sourcePathItems = (selectedFeedItems as Record<string, unknown>[]).map((s, i) => ({
      path_id: pathRow.id,
      feed_item_id: s.feed_item_id as string,
      order_index: i,
      reason: s.reason as string,
      expected_value: s.expected_value as string,
      citation_price_usdc: s.citation_price_usdc as number,
      unlock_price_usdc: s.unlock_price_usdc as number,
      creator_wallet: s.creator_wallet as string,
      source_url: s.source_url as string,
      source_title: (s.source_title as string) || null,
      source_hash: (s.source_hash as string) || null,
      status: "proposed",
    }));

    const { error: itemsErr } = await supabaseAdmin()
      .from("paylabs_source_path_items")
      .insert(sourcePathItems);

    if (itemsErr) {
      // Clean up path if items fail
      await supabaseAdmin()
        .from("paylabs_learning_paths")
        .delete()
        .eq("id", pathRow.id);
      return {
        error: `Failed to create source path items: ${itemsErr.message}`,
        pathStatus: "none",
      };
    }

    return {
      pathId: pathRow.id,
      pathStatus: "proposed",
      sourcePathItems,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Persist failed: ${msg}`, pathStatus: "none" };
  }
}

// ─── Proposal Graph ──────────────────────────────────────────────

const proposalGraph = new StateGraph(PayLabsTutorState)
  .addNode("intent_agent", intentAgent)
  .addNode("curriculum_planner_agent", curriculumPlannerAgent)
  .addNode("source_verifier_agent", sourceVerifierAgent)
  .addNode("persist_proposed_path", persistProposedPathNode)
  .addEdge(START, "intent_agent")
  .addEdge("intent_agent", "curriculum_planner_agent")
  .addEdge("curriculum_planner_agent", "source_verifier_agent")
  .addEdge("source_verifier_agent", "persist_proposed_path")
  .addEdge("persist_proposed_path", END)
  .compile();

// ─── Buy Graph ───────────────────────────────────────────────────

const buyGraph = new StateGraph(PayLabsTutorState)
  .addNode("policy_guard_agent", policyGuardAgent)
  .addNode("payment_receipt_executor_agent", paymentReceiptExecutorAgent)
  .addEdge(START, "policy_guard_agent")
  .addEdge("policy_guard_agent", "payment_receipt_executor_agent")
  .addEdge("payment_receipt_executor_agent", END)
  .compile();

// ─── Public API ──────────────────────────────────────────────────

export async function proposeLearningPath(input: {
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
    pathStatus: "none" as const,
    publishedLessons: [],
    unlockedLessonIds: [],
    selectedLessons: [],
    plannerNotes: [],
    verifiedLessons: [],
    rejectedLessons: [],
    availableFeedItems: [],
    selectedFeedItems: [],
    verifiedFeedItems: [],
    rejectedFeedItems: [],
    sourcePathItems: [],
  } as unknown as PayLabsTutorStateType);

  return {
    pathId: result.pathId,
    pathStatus: result.pathStatus,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    routeTier: tier,
    routeConfig: config,
    // Legacy lesson path fields (kept for compatibility)
    selectedLessons: result.selectedLessons,
    verifiedLessons: result.verifiedLessons,
    rejectedLessons: result.rejectedLessons,
    estimatedTotalUsdc: result.estimatedTotalUsdc,
    // RSSHub source path fields
    selectedFeedItems: result.selectedFeedItems,
    verifiedFeedItems: result.verifiedFeedItems,
    rejectedFeedItems: result.rejectedFeedItems,
    sourcePathItems: result.sourcePathItems,
    sourcePathTotalUsdc: result.sourcePathTotalUsdc,
    sourceCardCount: result.sourceCardCount,
    remainingUsdc: result.remainingUsdc,
    agentServiceCalls: result.agentServiceCalls || [],
    error: result.error,
  };
}

export async function buyApprovedLesson(input: {
  userWallet: string;
  pathId: string;
  lessonId: string;
}) {
  // Fetch path to get actual route_tier — NOT defaulting to "normal"
  const { data: pathRow } = await supabaseAdmin()
    .from("paylabs_learning_paths")
    .select("route_tier, route_config, agent_trace")
    .eq("id", input.pathId)
    .single();

  const tier: RouteTier = (pathRow?.route_tier as RouteTier) || "normal";
  const config = pathRow?.route_config || getRouteConfig(tier);
  const prompts = getPromptsForRoute(tier);

  // Buy graph does NOT change behavior by tier — same safety for all routes
  // But route_tier is now correctly propagated for logging
  const result = await buyGraph.invoke({
    userWallet: input.userWallet,
    pathId: input.pathId,
    lessonId: input.lessonId,
    routeTier: tier,
    routeConfig: config as Record<string, unknown>,
    routePrompts: prompts as unknown as Record<string, unknown>,
    topics: [],
    riskNotes: [],
    pathStatus: "none" as const,
    publishedLessons: [],
    unlockedLessonIds: [],
    selectedLessons: [],
    plannerNotes: [],
    verifiedLessons: [],
    rejectedLessons: [],
    availableFeedItems: [],
    selectedFeedItems: [],
    verifiedFeedItems: [],
    rejectedFeedItems: [],
    sourcePathItems: [],
  } as unknown as PayLabsTutorStateType);

  return {
    allowed: result.policyDecision?.allowed,
    unlockId: result.unlockId,
    receiptId: result.receiptId,
    runnerPaymentResult: result.runnerPaymentResult,
    error: result.error,
    policyDecision: result.policyDecision,
  };
}
