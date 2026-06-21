/**
 * Agent Service Schemas
 *
 * Zod schemas for all 9 delegated service inputs and outputs.
 * Every output must include safe_summary. No raw chain-of-thought.
 */

import { z } from "zod";

// ─── Intent Planner ──────────────────────────────────────────
export const IntentPlannerInput = z.object({
  goal: z.string().min(1),
  budgetUsdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type IntentPlannerInput = z.infer<typeof IntentPlannerInput>;

export const IntentPlannerOutput = z.object({
  normalized_goal: z.string(),
  intent_type: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  constraints: z.array(z.string()),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  safe_intent_summary: z.string(),
});
export type IntentPlannerOutput = z.infer<typeof IntentPlannerOutput>;

// ─── Query Builder ───────────────────────────────────────────
export const QueryBuilderInput = z.object({
  normalized_goal: z.string().min(1),
  topics: z.array(z.string()),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type QueryBuilderInput = z.infer<typeof QueryBuilderInput>;

export const QueryBuilderOutput = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  negative_filters: z.array(z.string()),
  source_preferences: z.array(z.string()),
  safe_query_summary: z.string(),
});
export type QueryBuilderOutput = z.infer<typeof QueryBuilderOutput>;

// ─── Signal Scout ────────────────────────────────────────────
export const SignalScoutInput = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type SignalScoutInput = z.infer<typeof SignalScoutInput>;

export const SignalScoutOutput = z.object({
  ranked_candidates: z.array(z.object({
    feed_item_id: z.string(),
    title: z.string(),
    publisher: z.string(),
    rank: z.number(),
    relevance_score: z.number(),
  })),
  top_candidates: z.array(z.string()),
  quick_relevance_notes: z.array(z.string()),
  safe_signal_summary: z.string(),
});
export type SignalScoutOutput = z.infer<typeof SignalScoutOutput>;

// ─── Intent Matcher ──────────────────────────────────────────
export const IntentMatcherInput = z.object({
  normalized_goal: z.string(),
  candidates: z.array(z.object({
    feed_item_id: z.string(),
    title: z.string(),
    publisher: z.string(),
    rank: z.number(),
  })),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type IntentMatcherInput = z.infer<typeof IntentMatcherInput>;

export const IntentMatcherOutput = z.object({
  relevance_score: z.number(),
  intent_fit_reason: z.string(),
  approved_for_quality_check: z.boolean(),
  safe_reason_summary: z.string(),
});
export type IntentMatcherOutput = z.infer<typeof IntentMatcherOutput>;

// ─── Source Verifier ─────────────────────────────────────────
export const SourceVerifierInput = z.object({
  feed_item_id: z.string(),
  source_url: z.string(),
  source_title: z.string(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type SourceVerifierInput = z.infer<typeof SourceVerifierInput>;

export const SourceVerifierOutput = z.object({
  quality_score: z.number(),
  credibility_score: z.number(),
  red_flags: z.array(z.string()),
  confidence: z.number(),
  safe_quality_summary: z.string(),
});
export type SourceVerifierOutput = z.infer<typeof SourceVerifierOutput>;

// ─── Value Allocator ─────────────────────────────────────────
export const ValueAllocatorInput = z.object({
  source_url: z.string(),
  source_title: z.string(),
  quality_score: z.number(),
  remaining_budget_usdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type ValueAllocatorInput = z.infer<typeof ValueAllocatorInput>;

export const ValueAllocatorOutput = z.object({
  roi_score: z.number(),
  estimated_value: z.number(),
  worth_label: z.enum(["high", "medium", "low", "skip"]),
  max_allowed_price: z.number().min(0),
  safe_value_summary: z.string(),
});
export type ValueAllocatorOutput = z.infer<typeof ValueAllocatorOutput>;

// ─── Trust Verifier ──────────────────────────────────────────
export const TrustVerifierInput = z.object({
  feed_item_id: z.string(),
  source_url: z.string(),
  creator_wallet: z.string().nullable(),
  claim_status: z.string(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type TrustVerifierInput = z.infer<typeof TrustVerifierInput>;

export const TrustVerifierOutput = z.object({
  risk_score: z.number(),
  provenance_ok: z.boolean(),
  creator_verified: z.boolean(),
  payout_target_hint: z.string().nullable(),
  trust_warnings: z.array(z.string()),
  safe_trust_summary: z.string(),
});
export type TrustVerifierOutput = z.infer<typeof TrustVerifierOutput>;

// ─── Payment Decider ─────────────────────────────────────────
export const PaymentDeciderInput = z.object({
  evaluations: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    quality_score: z.number(),
    risk_score: z.number(),
    roi_score: z.number(),
    estimated_value: z.number(),
    max_allowed_price: z.number(),
    creator_wallet: z.string().nullable(),
  })),
  total_budget_usdc: z.number().min(0),
  spent_usdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type PaymentDeciderInput = z.infer<typeof PaymentDeciderInput>;

export const PaymentDeciderOutput = z.object({
  approved_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    approved_price_usdc: z.number(),
    final_score: z.number(),
    risk_score: z.number(),
    creator_wallet: z.string().nullable(),
  })),
  skipped_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    skip_reason: z.string(),
  })),
  final_score: z.number(),
  total_estimated_spend: z.number(),
  payment_plan: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    amount_usdc: z.number(),
    creator_wallet: z.string().nullable(),
  })),
  safe_decision_summary: z.string(),
});
export type PaymentDeciderOutput = z.infer<typeof PaymentDeciderOutput>;

// ─── Payment Router ──────────────────────────────────────────
export const PaymentRouterInput = z.object({
  approved_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    approved_price_usdc: z.number(),
    creator_wallet: z.string().nullable(),
  })),
  discovery_run_id: z.string(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
export type PaymentRouterInput = z.infer<typeof PaymentRouterInput>;

export const PaymentRouterOutput = z.object({
  paid_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    payment_ref: z.string().nullable(),
    settlement_ref: z.string().nullable(),
    amount_usdc: z.number(),
  })),
  failed_payments: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    error: z.string(),
  })),
  payment_refs: z.array(z.string()),
  settlement_refs: z.array(z.string()),
  safe_payment_summary: z.string(),
});
export type PaymentRouterOutput = z.infer<typeof PaymentRouterOutput>;
