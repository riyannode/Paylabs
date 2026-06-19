/**
 * Tutor Intake LangGraph
 *
 * Two-node graph that runs BEFORE the proposal flow:
 * 1. tutor_intake_agent — classifies user intent
 * 2. route_x402_guard_agent — charges route toll via x402/Runner (when enabled)
 *
 * Graph: START → tutor_intake_agent → [conditional] → route_x402_guard_agent → END
 *
 * Conditional routing:
 * - If PAYLABS_ROUTE_TOLL_ENABLED=true AND needsClarification=false AND route exists → run guard
 * - Otherwise → skip guard, go to END
 *
 * This graph does NOT:
 * - create paths
 * - create receipts
 * - create unlocks
 * - call Circle
 * - call wallet APIs
 * - call contracts
 * - write to DB
 *
 * The only payment allowed: route toll via executeRouteTollPayment (Runner).
 */

import { START, END, StateGraph } from "@langchain/langgraph";
import { TutorIntakeState } from "./intake-state";
import type { TutorIntakeStateType } from "./intake-state";
import { tutorIntakeAgent } from "./tutor-intake-agent";
import { routeX402GuardAgent } from "./route-x402-guard-agent";

// ─── Conditional routing ────────────────────────────────────────

function shouldRunGuard(state: TutorIntakeStateType): string {
  const tollEnabled = process.env.PAYLABS_ROUTE_TOLL_ENABLED === "true";
  const hasRoute = !!state.recommendedRouteTier;
  const needsClar = state.needsClarification === true;

  if (tollEnabled && hasRoute && !needsClar) {
    return "route_x402_guard_agent";
  }
  return "skip_guard";
}

// ─── Intake Graph ───────────────────────────────────────────────

const intakeGraph = new StateGraph(TutorIntakeState)
  .addNode("tutor_intake_agent", tutorIntakeAgent)
  .addNode("route_x402_guard_agent", routeX402GuardAgent)
  .addEdge(START, "tutor_intake_agent")
  .addConditionalEdges("tutor_intake_agent", shouldRunGuard, {
    route_x402_guard_agent: "route_x402_guard_agent",
    skip_guard: END,
  })
  .addEdge("route_x402_guard_agent", END)
  .compile();

// ─── Public API ─────────────────────────────────────────────────

export async function runTutorIntake(input: {
  message: string;
  wallet?: string;
  currentGoal?: string;
  currentBudgetUsdc?: number;
}) {
  const result = await intakeGraph.invoke({
    userMessage: input.message,
    wallet: input.wallet,
    currentGoal: input.currentGoal,
    currentBudgetUsdc: input.currentBudgetUsdc,
  } as TutorIntakeStateType);

  return {
    assistantMessage: result.assistantMessage,
    normalizedGoal: result.normalizedGoal,
    recommendedRouteTier: result.recommendedRouteTier,
    routeLabel: result.routeLabel,
    learningLevel: result.learningLevel,
    suggestedBudgetUsdc: result.suggestedBudgetUsdc,
    confidence: result.confidence,
    needsClarification: result.needsClarification,
    clarificationQuestion: result.clarificationQuestion,
    reasoning: result.reasoning,
    error: result.error,
    // Route toll fields
    routeTollEnabled: result.routeTollEnabled,
    routeTollRequired: result.routeTollRequired,
    routeTollAmountUsdc: result.routeTollAmountUsdc,
    routePaymentId: result.routePaymentId,
    routePaymentRef: result.routePaymentRef,
    routeSettlementRef: result.routeSettlementRef,
    routePaymentStatus: result.routePaymentStatus,
    routePaymentError: result.routePaymentError,
    routeInputHash: result.routeInputHash,
  };
}
