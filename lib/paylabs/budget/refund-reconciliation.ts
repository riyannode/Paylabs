/**
 * Budget Refund Reconciliation — Deterministic Backend
 *
 * Computes refund eligibility from real payment state only.
 * Brain recommendation is advisory; backend decides final status.
 *
 * Rules:
 * - No LLM-generated prices
 * - No invented settlement values
 * - No invented tx hashes
 * - paidUpfrontUsdc must come from real entry payment/receipt only
 * - actualSettledUsdc comes only from services with settled === true
 * - maxRefundableUsdc = max(paidUpfrontUsdc - actualSettledUsdc - pendingSettlementUsdc, 0)
 * - Never execute refund without backend validation
 */

import type {
  BudgetRefundReconciliation,
  BrainRefundRecommendation,
  RefundStatus,
  OrchestratorRunState,
  OrchestratorInput,
  ExecutionPlan,
  BudgetSnapshot,
  ServiceEvaluation,
  PaymentEdge,
} from "../delegated-runtime/types";

// ─── Safe Budget Context (what Brain sees) ──────────────────

export interface SafeBudgetRefundContext {
  userBudgetUsdc: number;
  plannedCostUsdc: number;
  paidUpfrontUsdc: number;
  actualSettledUsdc: number;
  estimatedUnsettledUsdc: number;
  pendingSettlementUsdc: number;
  maxRefundableUsdc: number;
  runStatus: string;
  walletVerified: boolean;
  hasPendingSettlement: boolean;
  hasRefundReceipt: boolean;
}

// ─── Build Safe Budget Context ───────────────────────────────

export interface BuildSafeBudgetRefundContextInput {
  input: OrchestratorInput;
  state: OrchestratorRunState;
  executionPlan: ExecutionPlan | null;
  budgetSnapshot: BudgetSnapshot;
  serviceEvaluations: ServiceEvaluation[];
  paymentEdges: PaymentEdge[];
  paidUpfrontUsdc: number;
}

/**
 * Build safe budget refund context from real state.
 * All values come from deterministic sources — never LLM output.
 */
export function buildSafeBudgetRefundContext(
  raw: BuildSafeBudgetRefundContextInput
): SafeBudgetRefundContext {
  const {
    input,
    state,
    executionPlan,
    budgetSnapshot,
    serviceEvaluations,
    paymentEdges,
    paidUpfrontUsdc,
  } = raw;

  const plannedCostUsdc = executionPlan?.plannedCostUsdc ?? 0;

  // actualSettledUsdc: only from services where settled === true
  const actualSettledUsdc = serviceEvaluations
    .filter((ev) => ev.settled === true)
    .reduce((sum, ev) => sum + ev.costUsdc, 0);

  // Also count settled payment edges with real tx evidence
  const settledEdgeUsdc = paymentEdges
    .filter((pe) => pe.status === "executed" && !!pe.txHash)
    .reduce((sum, pe) => sum + pe.amountUsdc, 0);

  // Use the larger of service-level or edge-level settled amount
  const totalSettledUsdc = Math.max(actualSettledUsdc, settledEdgeUsdc);

  // estimatedUnsettledUsdc: services in audit_only mode (not settled)
  const estimatedUnsettledUsdc = serviceEvaluations
    .filter((ev) => !ev.settled && ev.status === "completed")
    .reduce((sum, ev) => sum + ev.costUsdc, 0);

  // pendingSettlementUsdc: services planned/approved but not settled
  const pendingSettlementUsdc = serviceEvaluations
    .filter(
      (ev) =>
        ev.status === "pending" ||
        ev.status === "running" ||
        (ev.status === "completed" && !ev.settled)
    )
    .reduce((sum, ev) => sum + ev.costUsdc, 0);

  const hasPendingSettlement = pendingSettlementUsdc > 0;

  // maxRefundableUsdc: what user overpaid beyond settled + pending
  const maxRefundableUsdc = Math.max(
    paidUpfrontUsdc - totalSettledUsdc - pendingSettlementUsdc,
    0
  );

  // walletVerified: basic check — wallet address provided and non-empty
  const walletVerified = !!input.userWallet && input.userWallet.length > 0;

  // hasRefundReceipt: check if any payment edge already shows a refund
  const hasRefundReceipt = paymentEdges.some(
    (pe) => pe.status === "executed" && pe.txHash && pe.amountUsdc < 0
  );

  return {
    userBudgetUsdc: input.userBudgetUsdc,
    plannedCostUsdc,
    paidUpfrontUsdc,
    actualSettledUsdc: totalSettledUsdc,
    estimatedUnsettledUsdc,
    pendingSettlementUsdc,
    maxRefundableUsdc,
    runStatus: state.orchestratorStatus,
    walletVerified,
    hasPendingSettlement,
    hasRefundReceipt,
  };
}

// ─── Safe Context for Brain (no raw payment data) ───────────

export interface BrainSafeRefundContext {
  routeTier: string;
  runStatus: string;
  plannedCostUsdc: number;
  paidUpfrontUsdc: number;
  actualSettledUsdc: number;
  estimatedUnsettledUsdc: number;
  pendingSettlementUsdc: number;
  maxRefundableUsdc: number;
  walletVerified: boolean;
}

/**
 * Strip internal fields from safe context before sending to Brain.
 * Never expose: raw x402 headers, signatures, Gateway responses, private keys.
 */
export function toBrainSafeRefundContext(
  ctx: SafeBudgetRefundContext,
  routeTier: string
): BrainSafeRefundContext {
  return {
    routeTier,
    runStatus: ctx.runStatus,
    plannedCostUsdc: ctx.plannedCostUsdc,
    paidUpfrontUsdc: ctx.paidUpfrontUsdc,
    actualSettledUsdc: ctx.actualSettledUsdc,
    estimatedUnsettledUsdc: ctx.estimatedUnsettledUsdc,
    pendingSettlementUsdc: ctx.pendingSettlementUsdc,
    maxRefundableUsdc: ctx.maxRefundableUsdc,
    walletVerified: ctx.walletVerified,
  };
}

// ─── Validate Brain Refund Recommendation ───────────────────

/**
 * Deterministic validation of Brain's advisory recommendation.
 * Backend has final say on refund status and amount.
 */
export function validateBrainRefundRecommendation(
  context: SafeBudgetRefundContext,
  brainRecommendation: BrainRefundRecommendation | null
): { refundStatus: RefundStatus; refundAmountUsdc: number; refundRequired: boolean } {
  // If no Brain recommendation, compute purely from context
  if (!brainRecommendation) {
    if (context.paidUpfrontUsdc <= 0 || context.maxRefundableUsdc <= 0) {
      return { refundStatus: "not_required", refundAmountUsdc: 0, refundRequired: false };
    }
    if (!context.walletVerified) {
      return { refundStatus: "manual_review", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
    }
    if (context.hasPendingSettlement) {
      return { refundStatus: "pending", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
    }
    return { refundStatus: "eligible", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
  }

  // Brain said no refund needed — but backend still validates
  if (brainRecommendation.action === "refund_not_required") {
    if (context.paidUpfrontUsdc > 0 && context.maxRefundableUsdc > 0) {
      // Brain says no, but math says yes — backend overrides to eligible
      return { refundStatus: "eligible", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
    }
    return { refundStatus: "not_required", refundAmountUsdc: 0, refundRequired: false };
  }

  // Brain says hold for pending settlement
  if (brainRecommendation.action === "hold_pending_settlement") {
    if (context.hasPendingSettlement) {
      return { refundStatus: "pending", refundAmountUsdc: 0, refundRequired: false };
    }
    // No pending settlement — Brain was wrong, check math
    if (context.maxRefundableUsdc > 0) {
      return { refundStatus: "eligible", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
    }
    return { refundStatus: "not_required", refundAmountUsdc: 0, refundRequired: false };
  }

  // Brain says manual review
  if (brainRecommendation.action === "manual_review") {
    return { refundStatus: "manual_review", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: context.maxRefundableUsdc > 0 };
  }

  // Brain says request_refund — backend validates
  if (brainRecommendation.action === "request_refund") {
    // Pre-checks: paidUpfrontUsdc must be positive
    if (context.paidUpfrontUsdc <= 0) {
      return { refundStatus: "not_required", refundAmountUsdc: 0, refundRequired: false };
    }

    // maxRefundableUsdc must be positive
    if (context.maxRefundableUsdc <= 0) {
      return { refundStatus: "not_required", refundAmountUsdc: 0, refundRequired: false };
    }

    // Wallet must be verified
    if (!context.walletVerified) {
      return { refundStatus: "manual_review", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: true };
    }

    // Pending settlement — wait
    if (context.hasPendingSettlement) {
      return { refundStatus: "pending", refundAmountUsdc: 0, refundRequired: false };
    }

    // Brain requested amount is advisory only — clamp to maxRefundableUsdc
    const brainRequested = brainRecommendation.requested_refund_usdc ?? context.maxRefundableUsdc;
    const refundAmountUsdc = Math.min(brainRequested, context.maxRefundableUsdc);

    return { refundStatus: "eligible", refundAmountUsdc, refundRequired: true };
  }

  // Unknown action — fallback
  return { refundStatus: "manual_review", refundAmountUsdc: context.maxRefundableUsdc, refundRequired: false };
}

// ─── Reconcile And Maybe Refund ─────────────────────────────

export interface ReconcileInput {
  context: SafeBudgetRefundContext;
  brainRecommendation: BrainRefundRecommendation | null;
}

/**
 * Full reconciliation: validate Brain recommendation, compute refund status.
 * Does NOT execute refund (no transfer function exists yet).
 * Returns budgetRefundReconciliation for OrchestratorOutput.
 */
export async function reconcileAndMaybeRefund(
  input: ReconcileInput
): Promise<BudgetRefundReconciliation> {
  const { context, brainRecommendation } = input;

  const { refundStatus, refundAmountUsdc, refundRequired } =
    validateBrainRefundRecommendation(context, brainRecommendation);

  // No refund execution — return eligible/pending status
  // Only set "refunded" if a real refund tx hash/receipt exists
  let finalStatus: RefundStatus = refundStatus;
  let refundTxHash: string | null = null;

  if (context.hasRefundReceipt && refundRequired) {
    // A refund receipt exists — but we don't have the hash from the edge yet
    // Mark as refunded only if we can prove it
    finalStatus = "refunded";
  }

  // If eligible but no executor, stay eligible (not refunded)
  // This is the current state: no transfer function exists
  if (finalStatus === "eligible") {
    finalStatus = "eligible";
  }

  const summary = buildRefundSummary(
    context,
    finalStatus,
    refundAmountUsdc,
    brainRecommendation
  );

  return {
    userBudgetUsdc: context.userBudgetUsdc,
    plannedCostUsdc: context.plannedCostUsdc,
    paidUpfrontUsdc: context.paidUpfrontUsdc,
    actualSettledUsdc: context.actualSettledUsdc,
    estimatedUnsettledUsdc: context.estimatedUnsettledUsdc,
    pendingSettlementUsdc: context.pendingSettlementUsdc,
    refundableUsdc: refundAmountUsdc,
    refundRequired,
    refundStatus: finalStatus,
    refundTxHash,
    brainRecommendation,
    summary,
  };
}

// ─── Summary Builder ────────────────────────────────────────

function buildRefundSummary(
  context: SafeBudgetRefundContext,
  status: RefundStatus,
  refundAmountUsdc: number,
  brainRec: BrainRefundRecommendation | null
): string {
  const tier = context.runStatus;

  switch (status) {
    case "not_required":
      if (context.paidUpfrontUsdc <= 0) {
        return "No upfront debit was captured. No refund is required.";
      }
      return "Settled amounts match or exceed the upfront payment. No refund is required.";

    case "eligible":
      return `Refund of ${refundAmountUsdc.toFixed(6)} USDC is eligible. Awaiting backend refund execution.`;

    case "pending":
      return "Settlement is still pending. Refund will be computed after all settlements complete.";

    case "refunded":
      return `Refund of ${refundAmountUsdc.toFixed(6)} USDC has been processed.`;

    case "failed":
      return "Refund computation encountered an error. Manual review may be required.";

    case "manual_review":
      if (!context.walletVerified) {
        return "Wallet verification is required before refund can be processed. Manual review needed.";
      }
      return `Refund of ${refundAmountUsdc.toFixed(6)} USDC flagged for manual review.`;

    default:
      return "Refund status unknown. Manual review recommended.";
  }
}
