/**
 * Intent Matcher Handler
 *
 * Reuses: source_ranker (relevance mode)
 * Macro-node: payment_decision
 * Execution modes:
 *   - deterministic (default): keyword overlap + metadata scoring
 *   - llm: LLM-powered relevance evaluation
 *   - hybrid: deterministic scoring + LLM reason explanation
 *
 * Evaluates candidate relevance against the normalized goal.
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const IntentMatcherSchema = z.object({
  relevance_score: z.number().min(0).max(1),
  intent_fit_reason: z.string(),
  approved_for_quality_check: z.boolean(),
  safe_summary: z.string(),
});

// ─── Deterministic Intent Matching ──────────────────────────

const RELEVANCE_THRESHOLD = 0.3;

function computeKeywordOverlap(goal: string, title: string, publisher: string): number {
  const goalWords = goal.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const titleLower = title.toLowerCase();
  const publisherLower = publisher.toLowerCase();

  if (goalWords.length === 0) return 0.5; // neutral if no meaningful words

  let matches = 0;
  for (const word of goalWords) {
    if (titleLower.includes(word)) matches += 2;
    if (publisherLower.includes(word)) matches += 1;
  }

  // Normalize: max possible score is goalWords.length * 3
  const maxPossible = goalWords.length * 3;
  return Math.min(matches / maxPossible, 1);
}

function runDeterministicIntentMatcher(
  normalizedGoal: string,
  candidates: Array<{ feed_item_id: string; title: string; publisher: string; rank: number }>
): Array<{
  feed_item_id: string;
  relevance_score: number;
  approved_for_quality_check: boolean;
  reason: string;
}> {
  return candidates.map((candidate) => {
    const overlap = computeKeywordOverlap(normalizedGoal, candidate.title, candidate.publisher);

    // Rank bonus: higher-ranked items get a small boost
    const rankBonus = Math.max(0, (10 - candidate.rank) / 10) * 0.1;
    const score = Math.min(overlap + rankBonus, 1);

    return {
      feed_item_id: candidate.feed_item_id,
      relevance_score: Math.round(score * 100) / 100,
      approved_for_quality_check: score >= RELEVANCE_THRESHOLD,
      reason: score >= RELEVANCE_THRESHOLD
        ? `Keyword overlap: ${Math.round(overlap * 100)}%, rank bonus: ${Math.round(rankBonus * 100)}%`
        : `Low relevance: ${Math.round(score * 100)}% (threshold: ${Math.round(RELEVANCE_THRESHOLD * 100)}%)`,
    };
  });
}

// ─── Handler ────────────────────────────────────────────────

export const intentMatcherHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { normalized_goal, candidates, routeTier } = input.payload as {
    normalized_goal: string;
    candidates: Array<{ feed_item_id: string; title: string; publisher: string; rank: number }>;
    routeTier?: DelegatedRouteTier;
  };

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("intent_matcher")) {
    const results = runDeterministicIntentMatcher(normalized_goal || "", candidates || []);
    const approved = results.filter((r) => r.approved_for_quality_check);
    const avgScore = results.length > 0
      ? results.reduce((sum, r) => sum + r.relevance_score, 0) / results.length
      : 0;

    return {
      ok: true,
      serviceName: "intent_matcher",
      data: {
        candidate_scores: results,
        approved_count: approved.length,
        total_count: results.length,
        avg_relevance: Math.round(avgScore * 100) / 100,
        safe_reason_summary: `Matched ${approved.length}/${results.length} candidates (avg: ${Math.round(avgScore * 100)}%). Deterministic keyword overlap.`,
      },
      safeSummary: `Matched ${approved.length}/${results.length} candidates (avg: ${Math.round(avgScore * 100)}%). Deterministic keyword overlap.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `You are PayLabs Intent Matcher. Evaluate how well the candidate sources match the user's normalized goal. Score relevance 0-1 and decide if the candidates are worth a quality check. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

  const result = await generateStructuredJson<z.infer<typeof IntentMatcherSchema>>({
    agentName: "intent_matcher",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal}"\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nEvaluate relevance. Return structured JSON only.`,
    schema: IntentMatcherSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic
    const results = runDeterministicIntentMatcher(normalized_goal || "", candidates || []);
    const approved = results.filter((r) => r.approved_for_quality_check);
    return {
      ok: true,
      serviceName: "intent_matcher",
      data: {
        candidate_scores: results,
        approved_count: approved.length,
        total_count: results.length,
        avg_relevance: 0,
        safe_reason_summary: `Matched ${approved.length}/${results.length} candidates (LLM failed, deterministic fallback).`,
      },
      safeSummary: `Matched ${approved.length}/${results.length} candidates (LLM failed, deterministic fallback).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "intent_matcher",
    data: {
      relevance_score: result.data.relevance_score,
      intent_fit_reason: result.data.intent_fit_reason,
      approved_for_quality_check: result.data.approved_for_quality_check,
      safe_reason_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
