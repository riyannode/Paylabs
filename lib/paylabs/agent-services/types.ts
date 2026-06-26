/**
 * Agent Services Types
 *
 * Types for the delegated service registry, handlers, and schemas.
 * 9 service agents that map to macro-node phases.
 */

// ─── Service Names ───────────────────────────────────────────
export type ServiceName =
  | "intent_planner"
  | "query_builder"
  | "signal_scout"
  | "signal_scout_basics"
  | "intent_matcher"
  | "source_verifier"
  | "value_allocator"
  | "trust_verifier"
  | "payment_decider"
  | "creator_attribution"
  | "advanced_evidence_evaluator"
  | "creator_payout_router";

// ─── Macro-Node Assignment ───────────────────────────────────
export type ServiceMacroNode =
  | "discovery_planner"
  | "payment_decision"
  | "settlement_memory";

// ─── Service Config ──────────────────────────────────────────
export interface ServiceConfig {
  serviceName: ServiceName;
  macroNode: ServiceMacroNode;
  reusedAgents: string[];
  requiresLlm: boolean;
  priceUsdc: number;
  endpointPath: string;
  allowedBuyers: string[];
  outputSchemaName: string;
  isActive: boolean;
  /** Env var name for seller wallet address (payTo). Required for x402-enabled services. */
  sellerWalletAddressEnv?: string;
  /** Env var name for buyer DCW wallet ID. Required for x402-enabled services. */
  buyerWalletIdEnv?: string;
}

// ─── Service Handler Input/Output ────────────────────────────
export interface ServiceHandlerInput {
  discoveryRunId: string;
  serviceName: ServiceName;
  buyerAgentName?: string;
  payload: Record<string, unknown>;
}

export interface ServiceHandlerOutput {
  ok: boolean;
  serviceName: ServiceName;
  data: Record<string, unknown> | null;
  safeSummary: string;
  settled: boolean;
  error: string | null;
}

// ─── Edge Validation ─────────────────────────────────────────
export interface EdgeValidationResult {
  allowed: boolean;
  buyerServiceName: string;
  sellerServiceName: string;
  error: string | null;
}

// ─── Service Handler Function Type ───────────────────────────
export type ServiceHandler = (
  input: ServiceHandlerInput
) => Promise<ServiceHandlerOutput>;
