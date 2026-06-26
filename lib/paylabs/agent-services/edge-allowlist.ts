/**
 * Edge Allowlist
 *
 * Defines allowed buyer→seller edges for delegated service calls.
 * Non-allowlisted edges fail closed.
 *
 * Payment graph edges (hierarchical):
 *   run_budget_controller → brain
 *   brain → discovery_planner / payment_decision / settlement_memory
 *   discovery_planner → intent_planner / query_builder / signal_scout / signal_scout_basics
 *   payment_decision → intent_matcher / source_verifier / value_allocator / trust_verifier / payment_decider
 *   settlement_memory → creator_attribution / advanced_evidence_evaluator / creator_payout_router
 */

import type { ServiceName, EdgeValidationResult } from "./types";

// ─── Allowed Edges ───────────────────────────────────────────
// Each edge: [buyer, seller]

// ── Payment graph edges (Brain + macro-nodes as x402 buyers) ──
const PAYMENT_GRAPH_EDGES: ReadonlyArray<readonly [string, string]> = [
  // run_budget_controller → Brain
  ["run_budget_controller", "brain"],
  // Brain → macro-nodes
  ["brain", "discovery_planner"],
  ["brain", "payment_decision"],
  ["brain", "settlement_memory"],
  // discovery_planner → child services
  ["discovery_planner", "intent_planner"],
  ["discovery_planner", "query_builder"],
  ["discovery_planner", "signal_scout"],
  ["discovery_planner", "signal_scout_basics"],
  // payment_decision → child services
  ["payment_decision", "intent_matcher"],
  ["payment_decision", "source_verifier"],
  ["payment_decision", "value_allocator"],
  ["payment_decision", "trust_verifier"],
  ["payment_decision", "payment_decider"],
  // settlement_memory → child services (creator distribution)
  ["settlement_memory", "creator_attribution"],
  ["settlement_memory", "advanced_evidence_evaluator"],
  ["settlement_memory", "creator_payout_router"],
] as const;

// ── Legacy direct edges (backward compat audit-only) ──
const ALLOWED_EDGES: ReadonlyArray<readonly [string, ServiceName]> = [
  ["run_budget_controller", "intent_planner"],
  ["intent_planner", "query_builder"],
  ["query_builder", "signal_scout"],
  ["signal_scout", "intent_matcher"],
  ["intent_matcher", "source_verifier"],
  ["source_verifier", "value_allocator"],
  ["value_allocator", "trust_verifier"],
  ["trust_verifier", "payment_decider"],
] as const;

// ─── Edge Lookup Set ─────────────────────────────────────────
const EDGE_SET = new Set([
  ...ALLOWED_EDGES.map(([buyer, seller]) => `${buyer}→${seller}`),
  ...PAYMENT_GRAPH_EDGES.map(([buyer, seller]) => `${buyer}→${seller}`),
]);

// ─── Public API ──────────────────────────────────────────────

/**
 * Validates that a buyer→seller edge is allowed.
 * Fails closed: any unknown edge is rejected.
 */
export function assertAllowedAgentServiceEdge(
  buyerAgentName: string,
  sellerServiceName: ServiceName
): EdgeValidationResult {
  const key = `${buyerAgentName}→${sellerServiceName}`;
  if (!EDGE_SET.has(key)) {
    return {
      allowed: false,
      buyerServiceName: buyerAgentName,
      sellerServiceName,
      error: `Edge not allowed: ${buyerAgentName} → ${sellerServiceName}. Allowed edges are defined in the edge allowlist.`,
    };
  }
  return {
    allowed: true,
    buyerServiceName: buyerAgentName,
    sellerServiceName,
    error: null,
  };
}

/**
 * Returns all allowed edges for inspection (read-only).
 */
export function getAllowedEdges(): ReadonlyArray<readonly [string, ServiceName]> {
  return ALLOWED_EDGES;
}

/**
 * Returns the count of allowlisted edges.
 */
export function getAllowedEdgeCount(): number {
  return ALLOWED_EDGES.length;
}
