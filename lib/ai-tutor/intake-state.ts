/**
 * Tutor Intake Agent State
 *
 * Separate from PayLabsTutorState — this graph runs BEFORE the proposal flow.
 * It classifies user intent and prepares proposal inputs. It does NOT:
 * - create paths
 * - create receipts
 * - create unlocks
 * - call Runner
 * - call Circle
 * - call wallet APIs
 * - call contracts
 * - write to DB
 */

import { Annotation } from "@langchain/langgraph";

export const TutorIntakeState = Annotation.Root({
  // Input: user's natural language message
  userMessage: Annotation<string>,

  // Input: optional wallet address (for context only, not used for payment)
  wallet: Annotation<string | undefined>,

  // Input: optional current goal/budget if user already filled them
  currentGoal: Annotation<string | undefined>,
  currentBudgetUsdc: Annotation<number | undefined>,

  // Output: assistant's reply to the user
  assistantMessage: Annotation<string | undefined>,

  // Output: cleaned/normalized goal for the proposal form
  normalizedGoal: Annotation<string | undefined>,

  // Output: recommended route tier for the proposal form
  recommendedRouteTier: Annotation<
    "normal" | "advanced" | "premium" | undefined
  >,

  // Output: human-readable route label for UI display
  routeLabel: Annotation<string | undefined>,

  // Output: inferred learning level
  learningLevel: Annotation<
    "easy" | "normal" | "builder" | "advanced" | "expert" | undefined
  >,

  // Output: suggested budget in USDC
  suggestedBudgetUsdc: Annotation<number | undefined>,

  // Output: confidence score 0-1
  confidence: Annotation<number | undefined>,

  // Output: whether the agent needs clarification from the user
  needsClarification: Annotation<boolean | undefined>,

  // Output: clarification question if needsClarification is true
  clarificationQuestion: Annotation<string | null | undefined>,

  // Output: agent's reasoning for the classification
  reasoning: Annotation<string | undefined>,

  // Output: error message if something went wrong
  error: Annotation<string | undefined>,
});

export type TutorIntakeStateType = typeof TutorIntakeState.State;
