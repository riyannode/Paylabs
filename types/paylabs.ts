/**
 * PayLabs Type Definitions
 * RSSHub-only types for source paths, feed items, payments, and agent actions.
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
  route_path: string;
  route_title: string;
  description: string | null;
  route_tier: RouteTier;
  price_usdc: number;
  is_active: boolean;
  created_at: string;
}

export interface PaylabsFeedItem {
  id: string;
  rsshub_route_id: string;
  item_guid: string;
  title: string;
  summary: string | null;
  content_sha256: string;
  published_at: string | null;
  fetched_at: string;
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
  agent_reasoning_summary: string;
  status: "proposed" | "approved" | "active" | "completed" | "cancelled";
  route_tier: RouteTier;
  route_config: Record<string, unknown>;
  agent_trace: Record<string, unknown>;
  created_by_agent_id: string;
  created_at: string;
}

export interface PaylabsSourcePathItem {
  id: string;
  source_path_id: string;
  feed_item_id: string;
  order_index: number;
  reason: string;
  expected_value: string;
  status: "proposed" | "approved" | "purchased" | "completed";
  // joined
  feed_item?: PaylabsFeedItem;
}

// ─── Payments ───────────────────────────────────────────────────

export interface PaylabsRoutePayment {
  id: string;
  user_wallet: string;
  route_tier: string;
  amount_usdc: number;
  payment_id: string;
  payment_ref: string | null;
  settlement_ref: string | null;
  tx_hash: string | null;
  input_hash: string;
  normalized_goal: string;
  status: "pending" | "completed" | "failed";
  created_at: string;
}

export interface PaylabsSourcePayment {
  id: string;
  user_wallet: string;
  source_path_id: string;
  source_path_item_id: string;
  feed_item_id: string;
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
  service_type: string;
  resource_url: string;
  input_hash: string;
  output_hash: string;
  amount_usdc: number;
  payment_id: string;
  payment_ref: string | null;
  settlement_ref: string | null;
  tx_hash: string | null;
  status: "pending" | "completed" | "failed";
  created_at: string;
}

export interface PaylabsAgentAction {
  id: string;
  user_wallet: string;
  agent_id: string;
  action_type: string;
  input_hash: string;
  output_hash: string;
  status: string;
  policy_decision: Record<string, unknown> | null;
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
