/**
 * PayLabs Type Definitions
 * RSSHub-only types for source paths, feed items, payments, and agent actions.
 *
 * Column names match supabase/migrations/1_rsshub.sql exactly.
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
  creator_wallet: string;
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
  creator_wallet: string;
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
  estimated_total_usdc: number;
  route_tier: RouteTier;
  route_config: Record<string, unknown>;
  status: "proposed" | "approved" | "active" | "completed" | "cancelled";
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
  creator_wallet: string;
  citation_price_usdc: number;
  unlock_price_usdc: number;
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
  input_hash: string | null;
  output_hash: string | null;
  status: string;
  policy_decision: Record<string, unknown> | null;
  payment_id: string | null;
  created_at: string;
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
