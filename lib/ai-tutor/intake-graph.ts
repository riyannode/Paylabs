/**
 * Tutor Intake LangGraph — Classification Only
 *
 * Single-node graph: START → tutor_intake_agent → END
 * Classifies user intent and returns route recommendation + toll quote.
 * Does NOT execute any payment. Does NOT call Runner.
 *
 * Route toll payment is handled separately by:
 * POST /api/paylabs/tutor/route-toll (explicit user confirmation required)
 */

import { START, END, StateGraph } from "@langchain/langgraph";
import { TutorIntakeState } from "./intake-state";
import type { TutorIntakeStateType } from "./intake-state";
import { tutorIntakeAgent } from "./tutor-intake-agent";

// ─── Route toll amounts from env ─────────────────────────────────

const ROUTE_TOLL_DEFAULTS: Record<string, number> = {
  normal: 0.000001,
  advanced: 0.000002,
  premium: 0.000003,
};

function getRouteTollQuote(tier: string | undefined): {
  enabled: boolean;
  required: boolean;
  amountUsdc: number;
} {
  const enabled = process.env.PAYLABS_ROUTE_TOLL_ENABLED === "true";
  if (!enabled) return { enabled: false, required: false, amountUsdc: 0 };
  if (!tier) return { enabled: true, required: false, amountUsdc: 0 };

  let amount: number;
  switch (tier) {
    case "normal":
      amount = Number(process.env.PAYLABS_ROUTE_TOLL_NORMAL_USDC) || ROUTE_TOLL_DEFAULTS.normal;
      break;
    case "advanced":
      amount = Number(process.env.PAYLABS_ROUTE_TOLL_ADVANCED_USDC) || ROUTE_TOLL_DEFAULTS.advanced;
      break;
    case "premium":
      amount = Number(process.env.PAYLABS_ROUTE_TOLL_PREMIUM_USDC) || ROUTE_TOLL_DEFAULTS.premium;
      break;
    default:
      amount = ROUTE_TOLL_DEFAULTS.normal;
  }

  return { enabled: true, required: true, amountUsdc: amount };
}

// ─── Intake Graph (classification only) ─────────────────────────

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

  // Compute toll quote (does NOT execute payment)
  const tollQuote = getRouteTollQuote(result.recommendedRouteTier);
  const tollRequired =
    tollQuote.enabled &&
    tollQuote.required &&
    !result.needsClarification;

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
    // Route toll quote (NOT payment — just informational)
    routeTollEnabled: tollQuote.enabled,
    routeTollRequired: tollRequired,
    routeTollAmountUsdc: tollRequired ? tollQuote.amountUsdc : 0,
  };
}
