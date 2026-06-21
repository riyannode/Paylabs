/**
 * Intent Matcher Handler
 *
 * Reuses: source_ranker (relevance mode)
 * Macro-node: discovery_planner
 * Requires LLM: yes
 *
 * Evaluates candidate relevance against the normalized goal.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const IntentMatcherSchema = z.object({
  relevance_score: z.number().min(0).max(1),
  intent_fit_reason: z.string(),
  approved_for_quality_check: z.boolean(),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Intent Matcher. Evaluate how well the candidate sources match the user's normalized goal. Score relevance 0-1 and decide if the candidates are worth a quality check. You cannot set prices, wallets, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

export const intentMatcherHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { normalized_goal, candidates, routeTier } = input.payload as {
    normalized_goal: string;
    candidates: Array<{ feed_item_id: string; title: string; publisher: string; rank: number }>;
    routeTier?: DelegatedRouteTier;
  };

  const result = await generateStructuredJson<z.infer<typeof IntentMatcherSchema>>({
    agentName: "intent_matcher",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal}"\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nEvaluate relevance. Return structured JSON only.`,
    schema: IntentMatcherSchema,
  });

  if (!result.ok) {
    return {
      ok: false,
      serviceName: "intent_matcher",
      data: null,
      safeSummary: `Intent matcher failed: ${result.error}`,
      settled: false,
      error: result.error,
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
