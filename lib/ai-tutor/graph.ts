/**
 * PayLabs Tutor LangGraph Workflow
 *
 * Two separate graphs:
 * 1. proposeLearningPath: START -> intent -> curriculum_planner -> source_verifier -> persist -> END
 * 2. buyApprovedLesson: START -> policy_guard -> payment_executor -> END
 *
 * Proposal and buying are separate invocations.
 * Buying is impossible until the user approves the path.
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

// ─── Persist Proposed Path Node ──────────────────────────────────

async function persistProposedPathNode(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, goal, budgetUsdc, verifiedLessons, estimatedTotalUsdc, allVerified } = state;

  if (!allVerified || !verifiedLessons || verifiedLessons.length === 0) {
    return {
      error: "Cannot persist: no verified lessons",
      pathStatus: "none",
    };
  }

  try {
    // Insert learning path
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
}) {
  const result = await proposalGraph.invoke({
    userWallet: input.userWallet,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    topics: [],
    riskNotes: [],
    pathStatus: "none" as const,
    publishedLessons: [],
    unlockedLessonIds: [],
    selectedLessons: [],
    plannerNotes: [],
    verifiedLessons: [],
    rejectedLessons: [],
  } as unknown as PayLabsTutorStateType);

  return {
    pathId: result.pathId,
    pathStatus: result.pathStatus,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    selectedLessons: result.selectedLessons,
    verifiedLessons: result.verifiedLessons,
    rejectedLessons: result.rejectedLessons,
    estimatedTotalUsdc: result.estimatedTotalUsdc,
    remainingUsdc: result.remainingUsdc,
    error: result.error,
  };
}

export async function buyApprovedLesson(input: {
  userWallet: string;
  pathId: string;
  lessonId: string;
}) {
  const result = await buyGraph.invoke({
    userWallet: input.userWallet,
    pathId: input.pathId,
    lessonId: input.lessonId,
    topics: [],
    riskNotes: [],
    pathStatus: "none" as const,
    publishedLessons: [],
    unlockedLessonIds: [],
    selectedLessons: [],
    plannerNotes: [],
    verifiedLessons: [],
    rejectedLessons: [],
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
