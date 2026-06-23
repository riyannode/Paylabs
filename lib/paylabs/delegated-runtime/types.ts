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
export type { ServiceName };
import type { SourceContext } from "../sources/types";
export type { SourceContext };

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
  /** Fees actually settled via x402 (real spend) */
  settledServiceFeesUsdc: number;
  /** Fees estimated/committed but not settled (audit-only) */
  estimatedServiceFeesUsdc: number;
  /** User budget total */
  userBudgetUsdc?: number;
  /** User budget used (controller→brain + brain→macro allocations) */
  userBudgetUsedUsdc?: number;
  /** Remaining user budget (not child payments) */
  remainingBudgetUsdc?: number;
  /** Treasury fee (controller→brain) */
  treasuryFeeUsdc?: number;
  /** Total macro allocation (brain→macro nodes) */
  macroAllocationUsdc?: number;
  /** Child payment volume (macro→child, internal to macro allocation) */
  childPaymentVolumeUsdc?: number;
  /** Gross payment volume (userBudgetUsed + childPaymentVolume) */
  grossPaymentVolumeUsdc?: number;
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
  /** Whether payment was settled via x402 (true) or audit-only (false) */
  settled: boolean;
  /** Execution mode for this evaluation */
  mode: "audit_only" | "x402";
  /** Safe payment metadata (only present when settled=true). Never stores raw signatures. */
  paymentMeta?: {
    amountAtomic: string;
    payTo: string;
    network: string;
    x402Version: number;
    txHash?: string | null;
    explorerUrl?: string | null;
  };
}

// ─── Frozen Execution Plan ────────────────────────────────────
export interface ExecutionPlan {
  selectedMacroNodes: MacroNodePhase[];
  selectedServices: ServiceName[];
  servicesByMacroNode: Record<MacroNodePhase, ServiceName[]>;
  plannedCostUsdc: number;
  plannedCostBreakdown: {
    brain_treasury_usdc: number;
    macro_node_fees_usdc: number;
    service_edge_fees_usdc: number;
    registry_check_fees_usdc: number;
    source_access_fees_usdc: number;
  };
  locked: boolean;
}

// ─── Payment Graph Edge ───────────────────────────────────────
export interface PaymentGraphEdge {
  edgeId: string;
  buyer: string;
  seller: string;
  amountUsdc: number;
  status: "planned" | "paid" | "failed" | "skipped";
  nodeType: "brain" | "macro_node" | "service";
  paymentRef: string | null;
  /** Real txHash from Gateway settle (if available) */
  txHash?: string | null;
  /** Block explorer URL (if txHash available) */
  explorerUrl?: string | null;
  /** Error message for failed edges */
  error?: string | null;
  /** Execution mode (audit_only or x402) */
  mode?: string;
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
  brainPlanning: BrainPlanningOutput | null;
  executionPlan: ExecutionPlan | null;
  paymentGraph: PaymentGraphEdge[];
  /** Safe Easy→Normal handoff (computed after discovery phase) */
  easyToNormalHandoff?: EasyToNormalHandoff;
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
  /** Buyer can be a macro-node (discovery_planner, payment_decision, settlement_memory) or a service */
  buyerServiceName: ServiceName | MacroNodePhase;
  sellerServiceName: ServiceName;
  amountUsdc: number;
  status: "planned" | "executed" | "failed" | "skipped";
  paymentRef: string | null;
  settlementRef: string | null;
  /** Payment layer: controller_to_brain, brain_to_macro, macro_to_child */
  layer?: "controller_to_brain" | "brain_to_macro" | "macro_to_child";
  /** Accounting role: user_budget_spend or macro_internal_child_spend */
  accountingRole?: "user_budget_spend" | "macro_internal_child_spend";
  /** Source of funds: user_budget or macro_allocation */
  sourceOfFunds?: "user_budget" | "macro_allocation";
  /** Circle x402 payment mode used */
  paymentMode?: "circle_gateway_wallet_batched" | "circle_gateway_wallet_batched_grouped_child" | "circle_gateway_wallet_batched_per_child_fallback";
  /** Base macro-node fee (excludes child budget) */
  nodeFeeUsdc?: number;
  /** Child budget portion of allocation */
  childBudgetUsdc?: number;
  /** Total allocation (nodeFee + childBudget) */
  allocationUsdc?: number;
  /** Real txHash from Gateway settle (null if not available) */
  txHash?: string | null;
  /** Block explorer URL (null if txHash not available) */
  explorerUrl?: string | null;
}

// ─── LLM Brain Planning Output ─────────────────────────────
export interface BrainPlanningOutput {
  normalized_goal: string;
  route_tier_hint: DelegatedRouteTier;
  discovery_strategy: string;
  suggested_query_variants: string[];
  service_execution_plan: string[];
  safe_brain_summary: string;
  // ── Deterministic quote planning fields ──
  /** Macro-nodes Brain selected for this run */
  selected_macro_nodes: MacroNodePhase[];
  /** Specific services Brain selected under those macro-nodes */
  selected_services: ServiceName[];
  /** Max registry/source checks Brain recommends */
  max_registry_checks: number;
  /** Max source accesses Brain recommends */
  max_source_accesses: number;
  /** Deterministic planned cost (computed from registry, NOT LLM) */
  planned_cost_usdc: number;
  /** Per-category cost breakdown */
  planned_cost_breakdown: {
    brain_treasury_usdc: number;
    macro_node_fees_usdc: number;
    service_edge_fees_usdc: number;
    registry_check_fees_usdc: number;
    source_access_fees_usdc: number;
  };
}

// ─── Tiered Run Summaries ─────────────────────────────────
export interface TieredRunSummaries {
  easy_summary?: string;
  normal_summary?: string;
  advanced_summary?: string;
  final_summary: string;
}

// ─── Safe Source Card (frontend-ready, no internals) ──────
export interface SafeSourceCard {
  feed_item_id: string;
  title: string;
  source_url: string;
  publisher: string;
  claim_status: string;
  creator_wallet: string | null;
}

// ─── Easy → Normal Handoff ───────────────────────────────
export interface EasyToNormalHandoff {
  normalizedGoal: string;
  easySummary: string;
  sourceCards: SafeSourceCard[];
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
  brainPlanning: BrainPlanningOutput | null;
  paymentGraph: PaymentGraphEdge[];
  tieredSummaries?: TieredRunSummaries;
  /** Safe Easy→Normal handoff: normalizedGoal + easySummary + sourceCards */
  easyToNormalHandoff?: EasyToNormalHandoff;
  /** Rich source context from signal_scout resolution (post PR #26) */
  sourceContext?: SourceContext;
  error: string | null;
}
