/**
 * Agent Service Schemas
 *
 * Zod schemas for all 9 delegated service inputs and outputs.
 * Every output must include safe_summary. No raw chain-of-thought.
 */

import { z } from "zod";
import type { ServiceName } from "./types";

// ─── Intent Planner ──────────────────────────────────────────
export const IntentPlannerInput = z.object({
  goal: z.string().min(1),
  budgetUsdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type IntentPlannerInput = z.infer<typeof IntentPlannerInput>;

export const IntentPlannerOutput = z.object({
  normalized_goal: z.string(),
  intent_type: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  constraints: z.array(z.string()),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  safe_intent_summary: z.string(),
});
type IntentPlannerOutput = z.infer<typeof IntentPlannerOutput>;

// ─── Query Builder ───────────────────────────────────────────
export const QueryBuilderInput = z.object({
  normalized_goal: z.string().min(1),
  topics: z.array(z.string()),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
  brain_query_variants: z.array(z.string()).optional(),
  brain_discovery_strategy: z.string().optional(),
  brain_normalized_goal: z.string().optional(),
});
type QueryBuilderInput = z.infer<typeof QueryBuilderInput>;

export const QueryBuilderOutput = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  negative_filters: z.array(z.string()),
  source_preferences: z.array(z.string()),
  safe_query_summary: z.string(),
});
type QueryBuilderOutput = z.infer<typeof QueryBuilderOutput>;

// ─── Signal Scout ────────────────────────────────────────────
export const SignalScoutInput = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  negative_filters: z.array(z.string()).optional(),
  source_preferences: z.array(z.string()).optional(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type SignalScoutInput = z.infer<typeof SignalScoutInput>;

export const SignalScoutOutput = z.object({
  ranked_candidates: z.array(z.object({
    feed_item_id: z.string(),
    title: z.string(),
    publisher: z.string(),
    rank: z.number(),
    relevance_score: z.number(),
    source_kind: z.string().optional(),
    provider: z.string().optional(),
    source_url: z.string().optional(),
    domain: z.string().nullable().optional(),
    summary: z.string().optional(),
    author: z.string().optional(),
    published_at: z.string().nullable().optional(),
    route_path: z.string().optional(),
    rsshub_feed_url: z.string().nullable().optional(),
    docs_url: z.string().nullable().optional(),
    reason: z.string().optional(),
  })),
  top_candidates: z.array(z.string()),
  quick_relevance_notes: z.array(z.string()),
  safe_signal_summary: z.string(),
});
type SignalScoutOutput = z.infer<typeof SignalScoutOutput>;

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
type IntentMatcherInput = z.infer<typeof IntentMatcherInput>;

export const IntentMatcherOutput = z.object({
  relevance_score: z.number(),
  intent_fit_reason: z.string(),
  approved_for_quality_check: z.boolean(),
  safe_reason_summary: z.string(),
});
type IntentMatcherOutput = z.infer<typeof IntentMatcherOutput>;

// ─── Source Verifier ─────────────────────────────────────────
export const SourceVerifierInput = z.object({
  feed_item_id: z.string(),
  source_url: z.string(),
  source_title: z.string(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type SourceVerifierInput = z.infer<typeof SourceVerifierInput>;

export const SourceVerifierOutput = z.object({
  quality_score: z.number(),
  credibility_score: z.number(),
  red_flags: z.array(z.string()),
  confidence: z.number(),
  safe_quality_summary: z.string(),
});
type SourceVerifierOutput = z.infer<typeof SourceVerifierOutput>;

// ─── Value Allocator ─────────────────────────────────────────
export const ValueAllocatorInput = z.object({
  source_url: z.string(),
  source_title: z.string(),
  quality_score: z.number(),
  remaining_budget_usdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type ValueAllocatorInput = z.infer<typeof ValueAllocatorInput>;

export const ValueAllocatorOutput = z.object({
  roi_score: z.number(),
  estimated_value: z.number(),
  worth_label: z.enum(["high", "medium", "low", "skip"]),
  max_allowed_price: z.number().min(0),
  safe_value_summary: z.string(),
});
type ValueAllocatorOutput = z.infer<typeof ValueAllocatorOutput>;

// ─── Trust Verifier ──────────────────────────────────────────
export const TrustVerifierInput = z.object({
  feed_item_id: z.string(),
  source_url: z.string(),
  creator_wallet: z.string().nullable(),
  claim_status: z.string(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type TrustVerifierInput = z.infer<typeof TrustVerifierInput>;

export const TrustVerifierOutput = z.object({
  risk_score: z.number(),
  provenance_ok: z.boolean(),
  creator_verified: z.boolean(),
  payout_target_hint: z.string().nullable(),
  trust_warnings: z.array(z.string()),
  safe_trust_summary: z.string(),
});
type TrustVerifierOutput = z.infer<typeof TrustVerifierOutput>;

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
type PaymentDeciderInput = z.infer<typeof PaymentDeciderInput>;

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
type PaymentDeciderOutput = z.infer<typeof PaymentDeciderOutput>;

// ─── Creator Attribution ──────────────────────────────────────
export const CreatorAttributionInput = z.object({
  approved_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    approved_price_usdc: z.number(),
    final_score: z.number(),
    risk_score: z.number(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string().optional(),
    quality_score: z.number().optional(),
    value_score: z.number().optional(),
    publisher: z.string().optional(),
    domain: z.string().nullable().optional(),
  })),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type CreatorAttributionInput = z.infer<typeof CreatorAttributionInput>;

export const CreatorAttributionOutput = z.object({
  creator_attributions: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  eligible_creator_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  pending_claim_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  failed_closed_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  safe_summary: z.string(),
});
type CreatorAttributionOutput = z.infer<typeof CreatorAttributionOutput>;

// ─── Advanced Evidence Evaluator ──────────────────────────────
export const AdvancedEvidenceEvaluatorInput = z.object({
  user_goal: z.string(),
  selected_creator_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  approved_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
    quality_score: z.number().optional(),
    value_score: z.number().optional(),
    creator_wallet: z.string().nullable(),
  })),
  creator_attributions: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  routeTier: z.enum(["advanced"]).optional(),
});
type AdvancedEvidenceEvaluatorInput = z.infer<typeof AdvancedEvidenceEvaluatorInput>;

export const AdvancedEvidenceEvaluatorOutputSchema = z.object({
  ok: z.boolean(),
  evaluator_version: z.literal("advanced_evidence_deep_agent_v1"),
  selected_source_ids: z.array(z.string()),
  evidence_matrix: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    creator_wallet: z.string().nullable(),
    contribution_type: z.enum(["primary_answer", "verification", "contrast", "missing_context", "freshness", "source_authority"]),
    contribution_summary: z.string(),
    materiality_score: z.number(),
    duplicate_risk: z.number(),
    memory_signal: z.string().optional(),
  })),
  why_two_sources_needed: z.string(),
  user_facing_rationale: z.string(),
  evaluator_confidence: z.number(),
  warnings: z.array(z.string()),
  safe_memory_update: z.object({
    source_reliability_notes: z.array(z.string()),
    creator_usage_notes: z.array(z.string()),
    evaluator_summary: z.string(),
  }),
  error: z.string().nullable(),
});

// ─── Creator Payout Router ────────────────────────────────────
export const CreatorPayoutRouterInput = z.object({
  creator_attributions: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  selected_creator_items: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
    eligibility_status: z.string(),
    reason: z.string(),
    final_score: z.number(),
    risk_score: z.number(),
  })),
  advanced_evaluator_output: z.object({
    ok: z.boolean(),
    evaluator_version: z.string(),
    evaluator_confidence: z.number(),
    user_facing_rationale: z.string(),
    warnings: z.array(z.string()),
  }).nullable().optional(),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
  bot_wallet: z.string().optional(),
  service_wallet: z.string().optional(),
});
type CreatorPayoutRouterInput = z.infer<typeof CreatorPayoutRouterInput>;

export const CreatorPayoutRouterOutputSchema = z.object({
  creator_payout_results: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    creator_wallet: z.string(),
    amount_atomic: z.string(),
    amount_usdc: z.number(),
    status: z.string(),
    settlement_id: z.string().nullable(),
    settlement_url: z.string().nullable(),
    tx_hash: z.string().nullable(),
    explorer_url: z.string().nullable(),
    batch_tx_hash: z.string().nullable(),
    batch_explorer_url: z.string().nullable(),
    error: z.string().nullable(),
  })),
  bot_share_result: z.object({
    status: z.string(),
    amount_atomic: z.string(),
    amount_usdc: z.number(),
  }),
  service_share_result: z.object({
    status: z.string(),
    amount_atomic: z.string(),
    amount_usdc: z.number(),
  }),
  split_plan: z.object({
    route_tier: z.string(),
    payout_limit: z.number(),
    planned_creator_pool_atomic: z.string(),
    actual_creator_pool_atomic: z.string(),
    pending_creator_reserve_atomic: z.string(),
  }),
  pending_creator_reserve: z.number(),
  safe_summary: z.string(),
});

// ─── Batch Input Schemas (for Payment Decision phase) ────────

export const BatchSourceVerifierInput = z.object({
  candidates: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
  })),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type BatchSourceVerifierInput = z.infer<typeof BatchSourceVerifierInput>;

export const BatchValueAllocatorInput = z.object({
  candidates: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    source_title: z.string(),
    quality_score: z.number(),
  })),
  remaining_budget_usdc: z.number().min(0),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type BatchValueAllocatorInput = z.infer<typeof BatchValueAllocatorInput>;

export const BatchTrustVerifierInput = z.object({
  candidates: z.array(z.object({
    feed_item_id: z.string(),
    source_url: z.string(),
    creator_wallet: z.string().nullable(),
    claim_status: z.string(),
  })),
  routeTier: z.enum(["easy", "normal", "advanced"]).optional(),
});
type BatchTrustVerifierInput = z.infer<typeof BatchTrustVerifierInput>;

// ─── Schema Lookup ───────────────────────────────────────────

const INPUT_SCHEMA_MAP: Partial<Record<ServiceName, z.ZodType<unknown>>> = {
  intent_planner: IntentPlannerInput,
  query_builder: QueryBuilderInput,
  signal_scout: SignalScoutInput,
  signal_scout_basics: SignalScoutInput,
  intent_matcher: IntentMatcherInput,
  source_verifier: BatchSourceVerifierInput,
  value_allocator: BatchValueAllocatorInput,
  trust_verifier: BatchTrustVerifierInput,
  payment_decider: PaymentDeciderInput,

  creator_attribution: CreatorAttributionInput,
  advanced_evidence_evaluator: AdvancedEvidenceEvaluatorInput,
  creator_payout_router: CreatorPayoutRouterInput,
};

/**
 * Get the input Zod schema for a service, or null if not found.
 */
export function getInputSchema(serviceName: ServiceName): z.ZodType<unknown> | null {
  return INPUT_SCHEMA_MAP[serviceName] ?? null;
}
