/**
 * Auto-Tier Route Preflight — Types & Helpers
 *
 * Safe backend types for the route-only preflight flow.
 * Used by the route-preflight endpoint to return locked tier + quote
 * before the final entry payment challenge.
 *
 * Safety rules:
 * - NEVER store raw x-payment, PAYMENT-SIGNATURE, EIP-712 data, or Gateway response.
 * - NEVER expose raw signatures, private keys, or secrets.
 * - Only safe metadata: amount_usdc, status, tx_hash, explorer_url,
 *   settlement_id, settlement_url, batch_tx_hash, batch_explorer_url,
 *   selected_tier, planned_cost_usdc, planned_cost_breakdown,
 *   safe Brain reasoning fields.
 */

import type { DelegatedRouteTier, ExecutionPlan } from "./types";
import type { DelegatedRunQuote } from "./quote-engine";

// ─── Constants ────────────────────────────────────────────────

/**
 * Route preflight routing fee — the exact amount charged for
 * the route-only preflight x402 challenge.
 * 1 atomic unit = 0.000001 USDC.
 */
export const ROUTE_PREFLIGHT_ROUTING_FEE_USDC = 0.000001;

/**
 * Atomic representation of the routing fee (6 decimals).
 */
export const ROUTE_PREFLIGHT_ROUTING_FEE_ATOMIC = "1";

// ─── Preflight Result Types ──────────────────────────────────

/**
 * Safe result from a route-only Brain preflight.
 * Contains only deterministic, non-secret data.
 */
export interface RoutePreflightResult {
  /** Selected tier resolved by Brain LLM */
  selectedTier: DelegatedRouteTier;
  /** Locked execution plan from Brain proposal + canonical tier bundle */
  lockedExecutionPlan: ExecutionPlan;
  /** Locked quote from quote engine (single source of truth for pricing) */
  lockedQuote: DelegatedRunQuote;
  /** Routing fee charged for preflight (always 0.000001 USDC) */
  routingFeeUsdc: number;
  /** Final entry payment = lockedQuote.plannedCostUsdc - routingFeeUsdc */
  finalEntryPaymentUsdc: number;
  /** Safe Brain reasoning fields (no raw LLM, no secrets) */
  safeBrainFields: RoutePreflightBrainFields;
}

/**
 * Safe Brain fields exposed in the preflight response and stored in agent_trace.
 * Never includes raw LLM output, chain-of-thought, or secrets.
 */
export interface RoutePreflightBrainFields {
  safe_brain_summary: string;
  user_visible_reasoning: string;
  tier_decision_reason: string;
  plan_rationale: string;
  planned_cost_breakdown: {
    brain_treasury_usdc: number;
    macro_node_fees_usdc: number;
    service_edge_fees_usdc: number;
    registry_check_fees_usdc: number;
    source_access_fees_usdc: number;
  };
  normalized_goal: string;
  discovery_strategy: string;
  suggested_query_variants: string[];
}

/**
 * Safe routing payment metadata stored in agent_trace.
 * Derived from Circle x402 settle result — no raw signatures.
 */
export interface RoutePreflightPaymentMeta {
  status: string;
  amount_usdc: number;
  tx_hash: string | null;
  explorer_url: string | null;
  settlement_id: string | null;
  settlement_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  batch_resolver_url: string | null;
  gateway_accepted: boolean;
}

/**
 * Full preflight data stored in agent_trace.auto_tier_preflight.
 */
export interface RoutePreflightTraceData {
  selected_tier: DelegatedRouteTier;
  routing_fee_usdc: number;
  final_entry_payment_usdc: number;
  locked_planned_cost_usdc: number;
  locked_planned_cost_breakdown: {
    brain_treasury_usdc: number;
    macro_node_fees_usdc: number;
    service_edge_fees_usdc: number;
    registry_check_fees_usdc: number;
    source_access_fees_usdc: number;
  };
  locked_selected_macro_nodes: string[];
  locked_selected_services: string[];
  locked_expected_payment_edges: number;
  brain_fields: RoutePreflightBrainFields;
  routing_payment: RoutePreflightPaymentMeta;
  preflight_completed_at: string;
}

/**
 * Safe API response from the route-preflight endpoint (paid retry).
 */
export interface RoutePreflightApiResponse {
  ok: true;
  status: "route_preflight_locked";
  discovery_run_id: string;
  selected_tier: DelegatedRouteTier;
  routing_fee_usdc: number;
  final_entry_payment_usdc: number;
  locked_quote: {
    plannedCostUsdc: number;
    executionFeeUsdc: number;
    plannedCreatorPoolUsdc: number;
    expectedPaymentEdges: number;
    plannedCostBreakdown: {
      brain_treasury_usdc: number;
      macro_node_fees_usdc: number;
      service_edge_fees_usdc: number;
      registry_check_fees_usdc: number;
      source_access_fees_usdc: number;
    };
  };
  locked_execution_plan: {
    selectedMacroNodes: string[];
    selectedServices: string[];
  };
  safe_brain_fields: RoutePreflightBrainFields;
  routing_payment: RoutePreflightPaymentMeta;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Build the safe API response from a RoutePreflightResult.
 */
export function buildRoutePreflightResponse(
  discoveryRunId: string,
  result: RoutePreflightResult,
  paymentMeta: RoutePreflightPaymentMeta,
): RoutePreflightApiResponse {
  return {
    ok: true,
    status: "route_preflight_locked",
    discovery_run_id: discoveryRunId,
    selected_tier: result.selectedTier,
    routing_fee_usdc: result.routingFeeUsdc,
    final_entry_payment_usdc: result.finalEntryPaymentUsdc,
    locked_quote: {
      plannedCostUsdc: result.lockedQuote.plannedCostUsdc,
      executionFeeUsdc: result.lockedQuote.executionFeeUsdc,
      plannedCreatorPoolUsdc: result.lockedQuote.plannedCreatorPoolUsdc,
      expectedPaymentEdges: result.lockedQuote.expectedPaymentEdges,
      plannedCostBreakdown: result.lockedExecutionPlan.plannedCostBreakdown,
    },
    locked_execution_plan: {
      selectedMacroNodes: result.lockedExecutionPlan.selectedMacroNodes,
      selectedServices: result.lockedExecutionPlan.selectedServices,
    },
    safe_brain_fields: result.safeBrainFields,
    routing_payment: paymentMeta,
  };
}

/**
 * Build safe routing payment metadata from a settle result.
 * Extracts only safe fields — never raw signatures or Gateway response.
 */
export function buildRoutePreflightPaymentMeta(
  settleResult: {
    ok: boolean;
    settled: boolean;
    gatewayAccepted?: boolean;
    paymentMeta?: {
      txHash?: string | null;
      explorerUrl?: string | null;
      settlementId?: string | null;
      settlementUrl?: string | null;
      batchTxHash?: string | null;
      batchExplorerUrl?: string | null;
      batchResolverUrl?: string | null;
      gatewayAccepted?: boolean;
    };
  },
): RoutePreflightPaymentMeta {
  return {
    status: settleResult.settled ? "paid" : "failed",
    amount_usdc: ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
    tx_hash: settleResult.paymentMeta?.txHash ?? null,
    explorer_url: settleResult.paymentMeta?.explorerUrl ?? null,
    settlement_id: settleResult.paymentMeta?.settlementId ?? null,
    settlement_url: settleResult.paymentMeta?.settlementUrl ?? null,
    batch_tx_hash: settleResult.paymentMeta?.batchTxHash ?? null,
    batch_explorer_url: settleResult.paymentMeta?.batchExplorerUrl ?? null,
    batch_resolver_url: settleResult.paymentMeta?.batchResolverUrl ?? null,
    gateway_accepted: settleResult.paymentMeta?.gatewayAccepted ?? settleResult.settled,
  };
}

// ─── Route-Only Brain Preflight ──────────────────────────────

/**
 * Run a route-only Brain preflight.
 *
 * Calls the existing Brain LLM planner to select a tier, then locks
 * the execution plan using the canonical quote engine.
 *
 * Does NOT:
 * - Run macro-node x402 payments
 * - Run child service x402 payments
 * - Buy sources
 * - Create creator payouts
 * - Write internal paid edges
 * - Run final orchestration
 *
 * @returns RoutePreflightResult with selected tier, locked quote, and safe Brain fields.
 * @throws If Brain planning fails or returns invalid tier hint.
 */
export async function runRouteOnlyBrainPreflight(params: {
  discoveryRunId: string;
  userGoal: string;
  userBudgetUsdc: number;
  userWallet: string;
}): Promise<RoutePreflightResult> {
  const { discoveryRunId, userGoal, userBudgetUsdc, userWallet } = params;

  // ── Step 1: Run Brain LLM planner (plan-only, no payments) ──
  const { runBrainPlannerGraph } = await import(
    "../langgraph/brain/brain-planner-graph"
  );

  const brainResult = await runBrainPlannerGraph({
    discoveryRunId,
    userGoal,
    routeTier: "auto" as unknown as import("./types").DelegatedRouteTier,
    userBudgetUsdc,
    userWallet,
  });

  if (!brainResult.ok || !brainResult.brainPlanning) {
    const errMsg = brainResult.error || "Brain planning returned no data";
    throw new Error(`route_preflight_brain_failed: ${errMsg}`);
  }

  const bp = brainResult.brainPlanning;

  // ── Step 2: Resolve auto tier from Brain's route_tier_hint ──
  const { resolveAutoTier } = await import("./state");

  const tierResult = resolveAutoTier("auto", bp.route_tier_hint);
  if (!tierResult.ok) {
    throw new Error(`route_preflight_tier_resolve_failed: ${tierResult.error}`);
  }

  const selectedTier = tierResult.tier;

  // ── Step 3: Lock execution plan from Brain proposal + canonical tier ──
  const { validateAndLockExecutionPlan } = await import("./state");

  const lockedPlan = validateAndLockExecutionPlan(
    selectedTier,
    (bp.selected_macro_nodes || []) as import("./types").MacroNodePhase[],
    (bp.selected_services || []) as import("../agent-services/types").ServiceName[],
    bp.max_registry_checks ?? 10,
    bp.max_source_accesses ?? 10,
  );

  // ── Step 4: Compute quote for the locked tier ──
  const { quoteDelegatedRun } = await import("./quote-engine");

  const lockedQuote = quoteDelegatedRun({
    routeTier: selectedTier,
    userBudgetUsdc,
    maxRegistryChecks: bp.max_registry_checks ?? 10,
    maxSourceAccesses: bp.max_source_accesses ?? 10,
  });
  // ── Budget guard: fail closed if locked quote exceeds user budget ──
  if (lockedQuote.budgetStatus === "over_budget") {
    throw new Error(
      `route_preflight_budget_exceeded: planned cost ${lockedQuote.plannedCostUsdc.toFixed(6)} USDC exceeds user budget ${userBudgetUsdc.toFixed(6)} USDC`
    );
  }

  // ── Step 5: Compute final entry payment ──
  const finalEntryPaymentUsdc = lockedQuote.plannedCostUsdc - ROUTE_PREFLIGHT_ROUTING_FEE_USDC;

  if (finalEntryPaymentUsdc < 0) {
    throw new Error(
      `route_preflight_invalid_quote: locked quote ${lockedQuote.plannedCostUsdc} < routing fee ${ROUTE_PREFLIGHT_ROUTING_FEE_USDC}`
    );
  }

  // ── Step 6: Build safe Brain fields ──
  const safeBrainFields: RoutePreflightBrainFields = {
    safe_brain_summary: bp.safe_brain_summary || "",
    user_visible_reasoning: bp.user_visible_reasoning || "",
    tier_decision_reason: bp.tier_decision_reason || "",
    plan_rationale: bp.plan_rationale || "",
    planned_cost_breakdown: lockedPlan.plannedCostBreakdown,
    normalized_goal: bp.normalized_goal || "",
    discovery_strategy: bp.discovery_strategy || "",
    suggested_query_variants: bp.suggested_query_variants || [],
  };

  return {
    selectedTier,
    lockedExecutionPlan: lockedPlan,
    lockedQuote,
    routingFeeUsdc: ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
    finalEntryPaymentUsdc,
    safeBrainFields,
  };
}
