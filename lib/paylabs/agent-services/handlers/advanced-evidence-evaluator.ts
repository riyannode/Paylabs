/**
 * Advanced Evidence Evaluator Handler
 *
 * Deep Agent + memory service for Advanced tier.
 * Evaluates whether selected creator sources materially improve the answer.
 *
 * Authority: LLM + memory for evidence evaluation ONLY.
 * Cannot choose payout amounts, wallets, or payment status.
 */

import type {
  ServiceHandlerInput,
  ServiceHandlerOutput,
} from "../types";
import { runAdvancedEvidenceDeepEvaluator } from "../../creator-distribution/deep-evaluator";
import type {
  CreatorAttribution,
  AdvancedEvidenceEvaluatorOutput,
} from "../../creator-distribution/types";

export async function advancedEvidenceEvaluatorHandler(
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> {
  const payload = input.payload as {
    user_goal?: string;
    selected_creator_items?: CreatorAttribution[];
    approved_items?: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      final_score: number;
      risk_score: number;
      quality_score?: number;
      value_score?: number;
      creator_wallet: string | null;
    }>;
    creator_attributions?: CreatorAttribution[];
  };

  const userGoal = payload.user_goal || "";
  const selectedCreatorItems = payload.selected_creator_items || [];
  const allApprovedItems = payload.approved_items || [];
  const creatorAttributions = payload.creator_attributions || [];

  if (selectedCreatorItems.length === 0) {
    return {
      ok: true,
      serviceName: "advanced_evidence_evaluator",
      data: {
        ok: true,
        evaluator_version: "advanced_evidence_deep_agent_v1",
        selected_source_ids: [],
        evidence_matrix: [],
        why_two_sources_needed: "No creator sources selected.",
        user_facing_rationale: "No creator sources to evaluate.",
        evaluator_confidence: 1,
        second_source_justified: false,
        composite_quality_score: 0,
        warnings: [],
        safe_memory_update: {
          source_reliability_notes: [],
          creator_usage_notes: [],
          evaluator_summary: "No sources to evaluate.",
        },
        error: null,
      } satisfies AdvancedEvidenceEvaluatorOutput,
      safeSummary: "Advanced evaluator: no sources to evaluate.",
      settled: false,
      error: null,
    };
  }

  const result = await runAdvancedEvidenceDeepEvaluator({
    discoveryRunId: input.discoveryRunId,
    userGoal,
    selectedCreatorItems,
    allApprovedItems,
    creatorAttributions,
    routeTier: "advanced",
  });

  return {
    ok: result.ok,
    serviceName: "advanced_evidence_evaluator",
    data: result as unknown as Record<string, unknown>,
    safeSummary: `Advanced evaluator: confidence=${(result.evaluator_confidence * 100).toFixed(0)}%, ${result.warnings.length} warnings.`,
    settled: false,
    error: result.error,
  };
}
