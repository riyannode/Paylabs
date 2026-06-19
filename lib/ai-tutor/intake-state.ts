/**
 * Tutor Intake Agent State
 *
 * Separate from PayLabsTutorState — this graph runs BEFORE the proposal flow.
 * It classifies user intent, optionally charges a route toll via x402/Runner,
 * and prepares proposal inputs.
 *
 * The intake agent itself does NOT:
 * - create paths
 * - create receipts
 * - create unlocks
 * - call Circle
 * - call wallet APIs
 * - call contracts
 * - write to DB
 *
 * The route x402 guard agent DOES call Runner (via executeRouteTollPayment)
 * to charge the route toll — this is the only payment allowed in this graph.
 */

import { Annotation } from "@langchain/langgraph";

export const TutorIntakeState = Annotation.Root({
  // Input: user's natural language message
  userMessage: Annotation<string>,

  // Input: wallet address (required for route toll when enabled)
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

  // ─── Route x402 Guard state ──────────────────────────────────

  // Whether route toll is enabled (from PAYLABS_ROUTE_TOLL_ENABLED env)
  routeTollEnabled: Annotation<boolean | undefined>,

  // Whether route toll payment was required and attempted
  routeTollRequired: Annotation<boolean | undefined>,

  // Route toll amount in USDC
  routeTollAmountUsdc: Annotation<number | undefined>,

  // Route toll wallet address (from PAYLABS_ROUTE_TOLL_WALLET env)
  routeTollWallet: Annotation<string | undefined>,

  // Payment proof fields from Runner
  routePaymentId: Annotation<string | undefined>,
  routePaymentRef: Annotation<string | undefined>,
  routeSettlementRef: Annotation<string | undefined>,
  routePaymentStatus: Annotation<string | undefined>,
  routePaymentError: Annotation<string | undefined>,

  // Deterministic input hash for audit trail
  routeInputHash: Annotation<string | undefined>,
});

export type TutorIntakeStateType = typeof TutorIntakeState.State;
