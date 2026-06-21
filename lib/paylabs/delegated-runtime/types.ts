/**
 * Delegated Runtime Types
 *
 * Core types for the PayLabs Run Orchestrator and macro-node phases.
 * The orchestrator is the single Brain that controls three macro-node phases:
 * 1. Discovery Planner
 * 2. Payment Decision Layer
 * 3. Settlement & Memory Layer
 */

import type { ServiceName } from "../agent-services/types";

// ─── Route Tiers ──────────────────────────────────────────────
export type DelegatedRouteTier = "easy" | "normal" | "advanced";

// Macro-node phases that the orchestrator can run
export type MacroNodePhase =
  | "discovery_planner"
  | "payment_decision"
  | "settlement_memory";

// Orchestrator status
export type OrchestratorStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Orchestrator Input ───────────────────────────────────────
export interface OrchestratorInput {
  discoveryRunId: string;
  userGoal: string;
  userWallet: string;
  userBudgetUsdc: number;
  routeTier: DelegatedRouteTier;
  paidReceiptIds?: Record<string, string>;
}

// ─── Budget Snapshot ──────────────────────────────────────────
export interface BudgetSnapshot {
  totalBudgetUsdc: number;
  spentUsdc: number;
  remainingUsdc: number;
  serviceSpend: Record<ServiceName, number>;
}

// ─── Service Evaluation ──────────────────────────────────────
export interface ServiceEvaluation {
  serviceName: ServiceName;
  macroNode: MacroNodePhase;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  safeSummary: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  costUsdc: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

// ─── Orchestrator Run State ──────────────────────────────────
export interface OrchestratorRunState {
  discoveryRunId: string;
  userGoal: string;
  userWallet: string;
  userBudgetUsdc: number;
  routeTier: DelegatedRouteTier;
  orchestratorStatus: OrchestratorStatus;
  budgetSnapshot: BudgetSnapshot;
  macroNodeProgress: Record<MacroNodePhase, "pending" | "running" | "completed" | "failed" | "skipped">;
  serviceEvaluations: ServiceEvaluation[];
  consensusDecisions: ConsensusDecision[];
  paymentPlan: PaymentPlanItem[];
  paymentEdges: PaymentEdge[];
  safeProgressSummaries: string[];
  delegatedRuntimeEnabled: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ─── Consensus Decision ──────────────────────────────────────
export interface ConsensusDecision {
  decisionId: string;
  macroNode: MacroNodePhase;
  serviceName: ServiceName;
  approved: boolean;
  reason: string;
  score: number;
  riskScore: number;
  estimatedSpendUsdc: number;
}

// ─── Payment Plan Item ───────────────────────────────────────
export interface PaymentPlanItem {
  itemId: string;
  sourceUrl: string;
  sourceTitle: string;
  priceUsdc: number;
  approved: boolean;
  skipReason: string | null;
  finalScore: number;
  riskScore: number;
}

// ─── Payment Edge ────────────────────────────────────────────
export interface PaymentEdge {
  edgeId: string;
  buyerServiceName: ServiceName;
  sellerServiceName: ServiceName;
  amountUsdc: number;
  status: "planned" | "executed" | "failed" | "skipped";
  paymentRef: string | null;
  settlementRef: string | null;
}

// ─── Orchestrator Output ─────────────────────────────────────
export interface OrchestratorOutput {
  discoveryRunId: string;
  status: OrchestratorStatus;
  routeTier: DelegatedRouteTier;
  phasesCompleted: MacroNodePhase[];
  safeProgressSummaries: string[];
  budgetSnapshot: BudgetSnapshot;
  consensusDecisions: ConsensusDecision[];
  paymentPlan: PaymentPlanItem[];
  paymentEdges: PaymentEdge[];
  serviceEvaluations: ServiceEvaluation[];
  error: string | null;
}
