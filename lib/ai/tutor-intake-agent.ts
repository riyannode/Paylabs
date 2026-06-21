/**
 * Tutor Intake Agent Node
 *
 * Single LangGraph node that classifies user intent into a route recommendation.
 * Uses invokeJsonAgent (same LLM infra as the agent workflow).
 *
 * Hard rules:
 * - Cannot execute payment
 * - Cannot call the backend payment executor
 * - Cannot call Circle
 * - Cannot call wallet APIs
 * - Cannot call contracts
 * - Cannot create source paths, payments
 * - Cannot write to DB
 * - Only classifies intent and prepares proposal inputs
 */

import { z } from "zod";
import type { TutorIntakeStateType } from "./intake-state";
import { TUTOR_INTAKE_PROMPT } from "./intake-prompts";
import { invokeJsonAgent } from "./llm-json";

// ─── Route label mapping ────────────────────────────────────────

const ROUTE_LABELS: Record<string, string> = {
  normal: "Easy Path",
  advanced: "Builder Path",
  premium: "Expert Path",
};

// ─── Zod schema for LLM structured output ───────────────────────

const TutorIntakeSchema = z.object({
  assistant_message: z
    .string()
    .describe("Friendly reply to the user explaining the recommendation"),
  normalized_goal: z
    .string()
    .describe("Cleaned, normalized goal for the proposal form"),
  recommended_route_tier: z
    .enum(["normal", "advanced", "premium"])
    .describe("Recommended route tier"),
  learning_level: z
    .enum(["easy", "normal", "builder", "advanced", "expert"])
    .describe("Inferred learning level"),
  suggested_budget_usdc: z
    .number()
    .describe("Suggested budget in USDC for this route"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score 0-1 for the classification"),
  needs_clarification: z
    .boolean()
    .describe("Whether the agent needs clarification from the user"),
  clarification_question: z
    .string()
    .nullable()
    .describe("Clarification question if needs_clarification is true, null otherwise"),
  reasoning: z
    .string()
    .describe("Agent's reasoning for the classification"),
});

type TutorIntakeResult = z.infer<typeof TutorIntakeSchema>;

// ─── Main agent node ────────────────────────────────────────────

export async function tutorIntakeAgent(
  state: TutorIntakeStateType
): Promise<Partial<TutorIntakeStateType>> {
  const { userMessage, wallet, currentGoal, currentBudgetUsdc } = state;

  if (!userMessage?.trim()) {
    return {
      error: "Message is required",
      assistantMessage: "Please describe what you want to learn.",
    };
  }

  // Build user message for the LLM
  const contextParts = [`User message: "${userMessage}"`];
  if (wallet) contextParts.push(`Wallet: ${wallet}`);
  if (currentGoal) contextParts.push(`Current goal: "${currentGoal}"`);
  if (currentBudgetUsdc !== undefined)
    contextParts.push(`Current budget: ${currentBudgetUsdc} USDC`);

  // Intake has no selected route yet; "normal" is used only for metadata/tracing.
  const llmResult = await invokeJsonAgent<TutorIntakeResult>({
    agentName: "tutor_intake",
    routeTier: "normal",
    prompt: TUTOR_INTAKE_PROMPT,
    userMessage: contextParts.join("\n"),
    schema: TutorIntakeSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as {
      ok: false;
      error: string;
      meta: Record<string, unknown>;
    };
    return {
      error: `Intake Agent LLM failed: ${errResult.error}`,
      assistantMessage:
        "Sorry, I couldn't process your request. Please try again or select a route manually.",
    };
  }

  const data = (llmResult as { ok: true; data: TutorIntakeResult; meta: Record<string, unknown> }).data;
  const tier = data.recommended_route_tier;

  return {
    assistantMessage: data.assistant_message,
    normalizedGoal: data.normalized_goal,
    recommendedRouteTier: tier,
    routeLabel: ROUTE_LABELS[tier] || "Easy Path",
    learningLevel: data.learning_level,
    suggestedBudgetUsdc: data.suggested_budget_usdc,
    confidence: data.confidence,
    needsClarification: data.needs_clarification,
    clarificationQuestion: data.clarification_question,
    reasoning: data.reasoning,
  };
}
