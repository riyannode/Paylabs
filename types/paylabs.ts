/**
 * PayLabs Type Definitions
 * RSSHub-only types for source paths, feed items, payments, and agent actions.
 *
 * Column names match supabase/migrations/1_rsshub.sql exactly.
 * Phase 1: monetization gate fields.
 */

// ─── Route Tier ─────────────────────────────────────────────────

export type RouteTier = "normal" | "advanced" | "premium";

export interface RouteConfig {
  tier: RouteTier;
  label: string;
  publicLabel: string;
  maxSourceCards: number;
  reasoningDepth: "low" | "medium" | "high";
  sourceStrictness: "standard" | "high" | "very_high";
  plannerStyle: "quick_intro" | "builder_path" | "deep_mastery";
  description: string;
}

// ─── RSSHub ─────────────────────────────────────────────────────

export interface PaylabsRsshubRoute {
  id: string;
  rsshub_base_url: string;
  route_path: string;
  title: string;
  description: string | null;
  source_type: string;
  creator_wallet: string | null;
  is_monetized: boolean;
  default_price_per_citation_usdc: number;
  default_price_per_unlock_usdc: number;
  is_active: boolean;
  last_synced_at: string | null;
  verification_status: "verified" | "pending_claim" | "unverified" | "rejected" | "disputed";
  verification_method: string | null;
  verified_at: string | null;
  verified_by: string | null;
  ownership_proof_url: string | null;
  ownership_proof_hash: string | null;
  created_at: string;
}

export interface PaylabsFeedItem {
  id: string;
  rsshub_route_id: string;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  author_name: string | null;
  publisher: string | null;
  published_at: string | null;
  tags: string[] | null;
  normalized_sha256: string | null;
  content_sha256: string | null;
  creator_wallet: string | null;
  is_monetized: boolean;
  price_per_citation_usdc: number;
  price_per_unlock_usdc: number;
  source_payload: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
  // joined
  rsshub_route?: PaylabsRsshubRoute;
}

// ─── Source Paths ───────────────────────────────────────────────

export interface PaylabsSourcePath {
  id: string;
  user_wallet: string;
  goal: string;
  budget_usdc: number;
  effective_spend_cap_usdc: number;
  estimated_total_usdc: number;
  estimated_creator_payout_usdc: number;
  estimated_agent_fee_usdc: number;
  estimated_treasury_fee_usdc: number;
  route_tier: RouteTier;
  route_config: Record<string, unknown>;
  route_limits: Record<string, unknown>;
  status: "proposed" | "approved" | "active" | "completed" | "cancelled";
  stop_reason: string | null;
  stop_limit_hit: boolean;
  agent_reasoning_summary: string | null;
  agent_trace: Record<string, unknown>;
  created_by_agent_id: string;
  created_at: string;
}

export interface PaylabsSourcePathItem {
  id: string;
  source_path_id: string;
  feed_item_id: string | null;
  order_index: number;
  reason: string | null;
  expected_value: string | null;
  source_url: string;
  source_title: string | null;
  publisher: string | null;
  author_name: string | null;
  normalized_sha256: string | null;
  content_sha256: string | null;
  source_hash: string | null;
  creator_wallet: string | null;
  is_monetized: boolean;
  citation_price_usdc: number;
  unlock_price_usdc: number;
  evidence_score: number | null;
  marginal_value_score: number | null;
  status: "proposed" | "cited" | "unlocked" | "completed" | "rejected";
  created_at: string;
  // joined
  feed_item?: PaylabsFeedItem;
}

// ─── Payments ───────────────────────────────────────────────────

export interface PaylabsRoutePayment {
  id: string;
  user_wallet: string;
  route_tier: string;
  goal: string;
  input_hash: string;
  amount_usdc: number;
  payment_id: string;
  payment_ref: string | null;
  settlement_ref: string | null;
  tx_hash: string | null;
  status: "completed" | "failed";
  created_at: string;
}

export interface PaylabsSourcePayment {
  id: string;
  user_wallet: string;
  source_path_id: string | null;
  source_path_item_id: string | null;
  feed_item_id: string | null;
  payment_kind: "citation" | "unlock";
  source_url: string;
  source_title: string | null;
  creator_wallet: string;
  route_tier: string | null;
  goal: string | null;
  payment_reason: string | null;
  amount_usdc: number;
  creator_amount_usdc: number;
  agent_fee_usdc: number;
  treasury_fee_usdc: number;
  split_rule_version: string;
  payment_id: string;
  payment_ref: string | null;
  settlement_ref: string | null;
  tx_hash: string | null;
  status: "pending" | "completed" | "failed";
  created_at: string;
}

export interface PaylabsAgentPayment {
  id: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  user_wallet: string;
  route_tier: string | null;
  service_type: string;
  resource_url: string | null;
  input_hash: string;
  output_hash: string | null;
  amount_usdc: number;
  payment_id: string;
  payment_ref: string | null;
  settlement_ref: string | null;
  tx_hash: string | null;
  status: "completed" | "failed";
  created_at: string;
}

export interface PaylabsAgentAction {
  id: string;
  user_wallet: string;
  agent_id: string;
  action_type: string;
  agent_name: string | null;
  route_tier: string | null;
  decision_label: string | null;
  input_hash: string | null;
  output_hash: string | null;
  status: string;
  source_path_id: string | null;
  feed_item_id: string | null;
  evidence_score: number | null;
  marginal_value_score: number | null;
  cost_usdc: number;
  max_cost_usdc: number | null;
  stop_reason: string | null;
  paid_via_payment_adapter: boolean;
  policy_decision: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  payment_id: string | null;
  created_at: string;
}

// ─── Stop Reasons ───────────────────────────────────────────────

export const STOP_REASONS = [
  "ENOUGH_EVIDENCE",
  "BUDGET_CAP_REACHED",
  "SOURCE_CAP_REACHED",
  "AGENT_CALL_CAP_REACHED",
  "LOW_MARGINAL_VALUE",
  "NO_VERIFIED_SOURCE_AVAILABLE",
  "POLICY_BLOCKED",
  "LLM_STRUCTURED_OUTPUT_PARSE_FAILED",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

// ─── Split Rule ─────────────────────────────────────────────────

export const SPLIT_RULE_VERSION = "v1_85_10_5" as const;
export const SPLIT_CREATOR_PCT = 0.85;
export const SPLIT_AGENT_PCT = 0.10;
export const SPLIT_TREASURY_PCT = 0.05;

export function computeSplit(amountUsdc: number): {
  creator_amount_usdc: number;
  agent_fee_usdc: number;
  treasury_fee_usdc: number;
} {
  return {
    creator_amount_usdc: Math.round(amountUsdc * SPLIT_CREATOR_PCT * 1e8) / 1e8,
    agent_fee_usdc: Math.round(amountUsdc * SPLIT_AGENT_PCT * 1e8) / 1e8,
    treasury_fee_usdc: Math.round(amountUsdc * SPLIT_TREASURY_PCT * 1e8) / 1e8,
  };
}

// ─── x402 Payment Challenge ────────────────────────────────────

export interface X402PaymentChallenge {
  network: string;
  receiverAddress: string;
  amount: string;
  token: string;
  chainId: number;
  eip712Domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  typedData: Record<string, unknown>;
}
