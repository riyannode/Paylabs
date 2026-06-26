/**
 * Creator Distribution Types
 *
 * Core types for PayLabs creator distribution V1.
 * All amounts in atomic USDC units (1 atomic = 0.000001 USDC = 10^-6).
 */

// ─── Creator Payout Tier ──────────────────────────────────────

export type CreatorPayoutTier = "easy" | "normal" | "advanced";

// ─── Approved Creator Item (from payment_decision) ────────────

export interface ApprovedCreatorItem {
  feed_item_id: string;
  source_url: string;
  source_title: string;
  approved_price_usdc: number;
  final_score: number;
  risk_score: number;
  creator_wallet: string | null;
  claim_status?: string;
  quality_score?: number;
  value_score?: number;
  publisher?: string;
  domain?: string | null;
}

// ─── Creator Attribution (from claim-policy) ──────────────────

export interface CreatorAttribution {
  feed_item_id: string;
  source_url: string;
  source_title: string;
  creator_wallet: string | null;
  claim_status: "verified" | "unclaimed" | "invalid" | "unknown";
  eligibility_status:
    | "eligible"
    | "ineligible"
    | "pending_claim"
    | "failed_closed";
  reason: string;
  final_score: number;
  risk_score: number;
}

// ─── Creator Payout Plan Item ─────────────────────────────────

export interface CreatorPayoutPlanItem {
  feed_item_id: string;
  source_url: string;
  source_title: string;
  creator_wallet: string;
  creator_amount_atomic: bigint;
  creator_amount_usdc: number;
  split_index: number;
  split_reason: string;
}

// ─── Creator Split Plan ───────────────────────────────────────

export interface CreatorSplitPlan {
  route_tier: CreatorPayoutTier;
  payout_limit: number;
  payout_unit_atomic: bigint;
  planned_creator_pool_atomic: bigint;
  actual_creator_pool_atomic: bigint;
  creator_total_atomic: bigint;
  bot_atomic: bigint;
  service_atomic: bigint;
  pending_creator_reserve_atomic: bigint;
  creator_items: CreatorPayoutPlanItem[];
  bot_wallet: string;
  service_wallet: string;
}

// ─── Creator Payout Result ────────────────────────────────────

export interface CreatorPayoutResult {
  feed_item_id: string;
  source_url: string;
  creator_wallet: string;
  amount_atomic: string;
  amount_usdc: number;
  status: "paid" | "gateway_accepted" | "pending" | "failed";
  settlement_id: string | null;
  settlement_url: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  error: string | null;
}

// ─── Advanced Evidence Evaluator Output ───────────────────────

export interface AdvancedEvidenceEvaluatorOutput {
  ok: boolean;
  evaluator_version: "advanced_evidence_deep_agent_v1";
  selected_source_ids: string[];
  evidence_matrix: Array<{
    feed_item_id: string;
    source_url: string;
    creator_wallet: string | null;
    contribution_type:
      | "primary_answer"
      | "verification"
      | "contrast"
      | "missing_context"
      | "freshness"
      | "source_authority";
    contribution_summary: string;
    materiality_score: number; // 0..1
    duplicate_risk: number; // 0..1
    reliability_score: number; // 0..1
    complementarity_score: number; // 0..1
    authority_score: number; // 0..1
    composite_score: number; // 0..1 weighted composite
    memory_signal?: string;
  }>;
  why_two_sources_needed: string;
  user_facing_rationale: string;
  evaluator_confidence: number; // 0..1
  second_source_justified: boolean;
  composite_quality_score: number; // 0..1 average of per-source composites
  warnings: string[];
  safe_memory_update: {
    source_reliability_notes: string[];
    creator_usage_notes: string[];
    evaluator_summary: string;
  };
  error: string | null;
}
