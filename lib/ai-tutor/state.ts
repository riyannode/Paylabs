import { Annotation } from "@langchain/langgraph";
import type { RouteLimits } from "./route-config";

/**
 * PayLabs Tutor Agent State
 * Shared state across all 15 agents in the LangGraph workflow.
 * Route tier changes planning behavior and prompt persona only.
 *
 * All agents are real LLM agents. Verification, policy, and
 * payment agents use LLM for reasoning/audit only — final decisions
 * remain deterministic.
 *
 * Stop-limit terminology: candidateSources, eligibleSources, selectedSources,
 * excludedSources, evidenceScore, marginalValueScore, stopReason, stopLimitHit.
 * No BUY/SKIP/CACHE.
 */

// Shared reducer: shallow-merge objects so each node adds its own key
const mergeReducer = (existing: Record<string, unknown>, update: Record<string, unknown>) => ({
  ...(existing || {}),
  ...(update || {}),
});

// Array concat reducer for agent actions
const concatReducer = <T>(existing: T[], update: T[]) => [
  ...(existing || []),
  ...(update || []),
];

export const PayLabsTutorState = Annotation.Root({
  // ─── User Input ─────────────────────────────────────────────
  userWallet: Annotation<string>,
  goal: Annotation<string | undefined>,
  normalizedGoal: Annotation<string | undefined>,
  budgetUsdc: Annotation<number | undefined>,

  // ─── Route ──────────────────────────────────────────────────
  routeTier: Annotation<"normal" | "advanced" | "premium" | undefined>,
  routeConfig: Annotation<Record<string, unknown> | undefined>,
  routePrompts: Annotation<Record<string, unknown> | undefined>,
  routeLimits: Annotation<RouteLimits | undefined>,
  effectiveSpendCapUsdc: Annotation<number | undefined>,

  // ─── Agent 1: Tutor Intake ─────────────────────────────────
  intent: Annotation<string | undefined>,

  // ─── Agent 2: Intent Classifier ────────────────────────────
  topics: Annotation<string[]>,
  constraints: Annotation<string[]>,
  learningLevel: Annotation<string | undefined>,
  riskNotes: Annotation<string[]>,

  // ─── Agent 3: Query Expander ───────────────────────────────
  expandedQueries: Annotation<string[]>,
  requiredConcepts: Annotation<string[]>,
  optionalConcepts: Annotation<string[]>,

  // ─── Agent 4: Feed Discovery ───────────────────────────────
  candidateSources: Annotation<unknown[]>,
  eligibleSources: Annotation<unknown[]>,

  // ─── Agent 5: Source Ranker ─────────────────────────────────
  rankedSources: Annotation<unknown[]>,

  // ─── Agent 6: Evidence Allocator ───────────────────────────
  selectedSources: Annotation<unknown[]>,
  excludedSources: Annotation<unknown[]>,
  evidenceScore: Annotation<number | undefined>,
  marginalValueScore: Annotation<number | undefined>,

  // ─── Agent 7: Stop-Limit Controller ────────────────────────
  stopReason: Annotation<string | undefined>,
  stopLimitHit: Annotation<boolean | undefined>,

  // ─── Agent 8: Budget Optimizer ─────────────────────────────
  estimatedTotalUsdc: Annotation<number | undefined>,
  estimatedCreatorPayoutUsdc: Annotation<number | undefined>,
  estimatedAgentFeeUsdc: Annotation<number | undefined>,
  estimatedTreasuryFeeUsdc: Annotation<number | undefined>,
  remainingUsdc: Annotation<number | undefined>,

  // ─── Agents 9-11: Verification ─────────────────────────────
  verifiedSources: Annotation<unknown[]>,
  rejectedSources: Annotation<unknown[]>,
  allVerified: Annotation<boolean | undefined>,
  sourceQualityResults: Annotation<unknown[]>,
  provenanceResults: Annotation<unknown[]>,
  ownershipResults: Annotation<unknown[]>,

  // ─── Source Path Management ────────────────────────────────
  sourcePathId: Annotation<string | undefined>,
  sourcePathStatus: Annotation<
    "none" | "proposed" | "approved" | "active" | "completed" | "cancelled"
  >,
  sourcePathItemId: Annotation<string | undefined>,

  // ─── Agent 12: Policy Guard ────────────────────────────────
  policyDecision: Annotation<Record<string, unknown> | undefined>,

  // ─── Agent 13: Payment Quote ───────────────────────────────
  paymentQuote: Annotation<Record<string, unknown> | undefined>,

  // ─── Agent 14: Payment Executor ────────────────────────────
  paymentAdapterResult: Annotation<Record<string, unknown> | undefined>,
  sourcePaymentId: Annotation<string | undefined>,

  // ─── Agent 15: Receipt Auditor ─────────────────────────────
  receiptAudit: Annotation<Record<string, unknown> | undefined>,
  receiptId: Annotation<string | undefined>,

  // ─── Agent Trace / Telemetry ───────────────────────────────
  agentTrace: Annotation<Record<string, unknown>>({
    reducer: mergeReducer,
    default: () => ({}),
  }),
  llmOutputs: Annotation<Record<string, unknown>>({
    reducer: mergeReducer,
    default: () => ({}),
  }),
  llmErrors: Annotation<Record<string, unknown>>({
    reducer: mergeReducer,
    default: () => ({}),
  }),
  agentCallCounts: Annotation<Record<string, number>>({
    reducer: (existing: Record<string, number>, update: Record<string, number>) => ({
      ...(existing || {}),
      ...(update || {}),
    }),
    default: () => ({}),
  }),
  agentSpendByAgent: Annotation<Record<string, number>>({
    reducer: (existing: Record<string, number>, update: Record<string, number>) => ({
      ...(existing || {}),
      ...(update || {}),
    }),
    default: () => ({}),
  }),
  agentActions: Annotation<Record<string, unknown>[]>({
    reducer: concatReducer,
    default: () => [],
  }),
  agentServiceCalls: Annotation<Record<string, unknown>[]>({
    reducer: concatReducer,
    default: () => [],
  }),

  // ─── Error Tracking ────────────────────────────────────────
  error: Annotation<string | undefined>,
});

export type PayLabsTutorStateType = typeof PayLabsTutorState.State;
