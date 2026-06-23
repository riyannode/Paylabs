/**
 * LangGraph Shared State Annotations
 *
 * Common state shapes used across all LangGraph graphs:
 * - BrainPlannerGraph
 * - DiscoveryPlannerGraph
 * - PaymentDecisionGraph
 * - SettlementMemoryGraph
 *
 * Rules:
 * - LangGraph = internal execution orchestration ONLY
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Must NOT call SERVICE_HANDLERS directly
 * - Service nodes must call callDelegatedService()
 */

import { Annotation } from "@langchain/langgraph";
import type { ServiceName } from "../../agent-services/types";
import type {
  MacroNodePhase,
  DelegatedRouteTier,
  ServiceEvaluation,
  PaymentEdge,
  BudgetSnapshot,
  BrainPlanningOutput,
} from "../../delegated-runtime/types";

// ─── Concat reducer for arrays ──────────────────────────────

function concatReducer<T>(existing: T[], update: T[]): T[] {
  return [...existing, ...update];
}

// ─── Discovery Planner State ────────────────────────────────

export const DiscoveryPlannerState = Annotation.Root({
  // Input
  discoveryRunId: Annotation<string>,
  userGoal: Annotation<string>,
  routeTier: Annotation<DelegatedRouteTier>,
  userBudgetUsdc: Annotation<number>,

  // Options
  selectedServices: Annotation<ServiceName[]>({
    reducer: concatReducer<ServiceName>,
    default: () => [],
  }),
  parentWalletId: Annotation<string | undefined>,

  // Brain planning pass-through
  brainNormalizedGoal: Annotation<string | undefined>,
  brainDiscoveryStrategy: Annotation<string | undefined>,
  brainSuggestedQueryVariants: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  brainSafeSummary: Annotation<string | undefined>,

  // Intent Planner output
  normalizedGoal: Annotation<string | undefined>,
  intentType: Annotation<string | undefined>,
  constraints: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  routeTierHint: Annotation<string | undefined>,

  // Query Builder output
  expandedQueries: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  entityTerms: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),

  // Signal Scout output
  rankedCandidates: Annotation<Array<{
    feed_item_id: string;
    title: string;
    publisher: string;
    rank: number;
    relevance_score: number;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),
  topCandidates: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),

  // Filters and preferences (from query_builder)
  negativeFilters: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  sourcePreferences: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),

  // Accumulated state
  serviceEvaluations: Annotation<ServiceEvaluation[]>({
    reducer: concatReducer<ServiceEvaluation>,
    default: () => [],
  }),
  paymentEdges: Annotation<PaymentEdge[]>({
    reducer: concatReducer<PaymentEdge>,
    default: () => [],
  }),
  progressSummaries: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  budgetSnapshot: Annotation<BudgetSnapshot>,

  // Error tracking
  error: Annotation<string | undefined>,
});

export type DiscoveryPlannerStateType = typeof DiscoveryPlannerState.State;

// ─── Payment Decision State ─────────────────────────────────

export const PaymentDecisionState = Annotation.Root({
  // Input
  discoveryRunId: Annotation<string>,
  userGoal: Annotation<string>,
  routeTier: Annotation<DelegatedRouteTier>,
  userBudgetUsdc: Annotation<number>,

  // Options
  selectedServices: Annotation<ServiceName[]>({
    reducer: concatReducer<ServiceName>,
    default: () => [],
  }),
  parentWalletId: Annotation<string | undefined>,

  // Candidates from discovery_planner
  candidates: Annotation<Array<{
    feed_item_id: string;
    source_url?: string;
    title: string;
    publisher: string;
    rank: number;
    relevance_score: number;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),

  // Intent Matcher output
  intentMatchApproved: Annotation<boolean | undefined>,
  intentMatchScore: Annotation<number>,

  // Source Verifier output (batch)
  qualityScores: Annotation<Record<string, number>>({
    reducer: (existing, update) => ({ ...existing, ...update }),
    default: () => ({}),
  }),

  // Value Allocator output (batch)
  valueScores: Annotation<Record<string, {
    roi: number;
    estimated_value: number;
    max_allowed_price: number;
  }>>({
    reducer: (existing, update) => ({ ...existing, ...update }),
    default: () => ({}),
  }),

  // Trust Verifier output (batch)
  riskScores: Annotation<Record<string, number>>({
    reducer: (existing, update) => ({ ...existing, ...update }),
    default: () => ({}),
  }),

  // Payment Decider output
  approvedItems: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),
  skippedItems: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    skip_reason: string;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),
  totalEstimatedSpend: Annotation<number>,

  // Candidate metadata (populated by prepare-candidates node)
  candidateMeta: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    creator_wallet: string | null;
    claim_status: string;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),

  // Accumulated state
  serviceEvaluations: Annotation<ServiceEvaluation[]>({
    reducer: concatReducer<ServiceEvaluation>,
    default: () => [],
  }),
  paymentEdges: Annotation<PaymentEdge[]>({
    reducer: concatReducer<PaymentEdge>,
    default: () => [],
  }),
  progressSummaries: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  budgetSnapshot: Annotation<BudgetSnapshot>,

  // Error tracking
  error: Annotation<string | undefined>,
});

export type PaymentDecisionStateType = typeof PaymentDecisionState.State;

// ─── Settlement Memory State ────────────────────────────────

export const SettlementMemoryState = Annotation.Root({
  // Input
  discoveryRunId: Annotation<string>,
  userGoal: Annotation<string>,
  routeTier: Annotation<DelegatedRouteTier>,
  userBudgetUsdc: Annotation<number>,

  // Options
  selectedServices: Annotation<ServiceName[]>({
    reducer: concatReducer<ServiceName>,
    default: () => [],
  }),
  parentWalletId: Annotation<string | undefined>,

  // Approved items from payment_decision
  approvedItems: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),

  // Payment Router output
  routedItems: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    amount_usdc: number;
    status: "planned";
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),
  failedItems: Annotation<Array<{
    feed_item_id: string;
    source_url: string;
    error: string;
  }>>({
    reducer: concatReducer,
    default: () => [],
  }),

  // Accumulated state
  serviceEvaluations: Annotation<ServiceEvaluation[]>({
    reducer: concatReducer<ServiceEvaluation>,
    default: () => [],
  }),
  paymentEdges: Annotation<PaymentEdge[]>({
    reducer: concatReducer<PaymentEdge>,
    default: () => [],
  }),
  progressSummaries: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  budgetSnapshot: Annotation<BudgetSnapshot>,

  // Error tracking
  error: Annotation<string | undefined>,
});

export type SettlementMemoryStateType = typeof SettlementMemoryState.State;

// ─── Brain Planner State ────────────────────────────────────

export const BrainPlannerState = Annotation.Root({
  // Input
  discoveryRunId: Annotation<string>,
  userGoal: Annotation<string>,
  routeTier: Annotation<DelegatedRouteTier>,
  userBudgetUsdc: Annotation<number>,
  userWallet: Annotation<string>,

  // Brain planning output
  normalizedGoal: Annotation<string | undefined>,
  routeTierHint: Annotation<DelegatedRouteTier | undefined>,
  discoveryStrategy: Annotation<string | undefined>,
  suggestedQueryVariants: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  serviceExecutionPlan: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),
  safeBrainSummary: Annotation<string | undefined>,
  selectedMacroNodes: Annotation<MacroNodePhase[]>({
    reducer: concatReducer<MacroNodePhase>,
    default: () => [],
  }),
  selectedServices: Annotation<ServiceName[]>({
    reducer: concatReducer<ServiceName>,
    default: () => [],
  }),
  maxRegistryChecks: Annotation<number>,
  maxSourceAccesses: Annotation<number>,
  plannedCostUsdc: Annotation<number>,

  // Tiered summaries
  easySummary: Annotation<string | undefined>,
  normalSummary: Annotation<string | undefined>,
  advancedSummary: Annotation<string | undefined>,
  finalSummary: Annotation<string | undefined>,

  // Progress tracking
  progressSummaries: Annotation<string[]>({
    reducer: concatReducer<string>,
    default: () => [],
  }),

  // Brain planning output (full)
  brainPlanning: Annotation<BrainPlanningOutput | undefined>,

  // Error tracking
  error: Annotation<string | undefined>,
});

export type BrainPlannerStateType = typeof BrainPlannerState.State;
