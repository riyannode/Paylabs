/**
 * Tutor Intake LangGraph
 *
 * Separate graph that runs BEFORE the proposal flow.
 * Classifies user intent and prepares proposal inputs.
 *
 * Graph: START → tutor_intake_agent → END
 *
 * This graph does NOT:
 * - create paths
 * - create receipts
 * - create unlocks
 * - call Runner
 * - call Circle
 * - call wallet APIs
 * - call contracts
 * - write to DB
 */

import { START, END, StateGraph } from "@langchain/langgraph";
import { TutorIntakeState } from "./intake-state";
import type { TutorIntakeStateType } from "./intake-state";
import { tutorIntakeAgent } from "./tutor-intake-agent";

// ─── Intake Graph ───────────────────────────────────────────────

const intakeGraph = new StateGraph(TutorIntakeState)
  .addNode("tutor_intake_agent", tutorIntakeAgent)
  .addEdge(START, "tutor_intake_agent")
  .addEdge("tutor_intake_agent", END)
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
  };
}
