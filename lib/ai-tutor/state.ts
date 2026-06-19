import { Annotation } from "@langchain/langgraph";

/**
 * PayLabs Tutor Agent State
 * Shared state across all 5 agents in the LangGraph workflow.
 */
export const PayLabsTutorState = Annotation.Root({
  // User input
  userWallet: Annotation<string>,
  goal: Annotation<string | undefined>,
  budgetUsdc: Annotation<number | undefined>,

  // Agent 1: Intent Agent output
  normalizedGoal: Annotation<string | undefined>,
  topics: Annotation<string[]>,
  learningLevel: Annotation<string | undefined>,
  maxLessonPriceUsdc: Annotation<number | undefined>,
  riskNotes: Annotation<string[]>,

  // Path management
  pathId: Annotation<string | undefined>,
  pathStatus: Annotation<
    "none" | "proposed" | "approved" | "active" | "completed" | "cancelled"
  >,

  // Agent 2: Curriculum Planner output
  publishedLessons: Annotation<unknown[]>,
  unlockedLessonIds: Annotation<string[]>,
  selectedLessons: Annotation<unknown[]>,
  estimatedTotalUsdc: Annotation<number | undefined>,
  remainingUsdc: Annotation<number | undefined>,
  plannerNotes: Annotation<string[]>,

  // Agent 3: Source Verifier output
  verifiedLessons: Annotation<unknown[]>,
  rejectedLessons: Annotation<unknown[]>,
  allVerified: Annotation<boolean | undefined>,

  // Agent 4: Policy Guard output
  lessonId: Annotation<string | undefined>,
  policyDecision: Annotation<Record<string, unknown> | undefined>,

  // Agent 5: Payment & Receipt Executor output
  runnerPaymentResult: Annotation<Record<string, unknown> | undefined>,
  unlockId: Annotation<string | undefined>,
  receiptId: Annotation<string | undefined>,

  // Error tracking
  error: Annotation<string | undefined>,
});

export type PayLabsTutorStateType = typeof PayLabsTutorState.State;
