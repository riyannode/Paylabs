/**
 * Value Allocator Handler
 *
 * Reuses: budget_optimizer + payment_quote
 * Macro-node: payment_decision
 * Requires LLM: yes (explanation only — budget math is deterministic)
 *
 * Computes ROI, estimated value, and max allowed price.
 * Budget math is MANDATORY deterministic. LLM only for safe explanation.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { toInternalRouteTier } from "./helpers";

const ValueAllocatorSchema = z.object({
  roi_score: z.number().min(0).max(1),
  estimated_value: z.number().min(0),
  worth_label: z.enum(["high", "medium", "low", "skip"]),
  explanation: z.string(),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Value Allocator. Evaluate the ROI and estimated value of a source given its quality and the remaining budget. Suggest a worth label (high/medium/low/skip). You cannot set final prices or execute payments. Your explanation must be concise. Return structured JSON only. Always include a safe_summary field.`;

// Deterministic budget math — no LLM
function computeMaxAllowedPrice(
  qualityScore: number,
  remainingBudgetUsdc: number
): number {
  // Max 20% of remaining budget per item, capped at quality-proportional amount
  const maxByBudget = remainingBudgetUsdc * 0.2;
  const maxByQuality = qualityScore * 0.01; // quality 0-1 maps to 0-0.01 USDC
  return Math.min(maxByBudget, maxByQuality);
}

export const valueAllocatorHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { source_url, source_title, quality_score, remaining_budget_usdc, routeTier } =
    input.payload as {
      source_url: string;
      source_title: string;
      quality_score: number;
      remaining_budget_usdc: number;
      routeTier?: DelegatedRouteTier;
    };

  // Deterministic budget math
  const maxAllowedPrice = computeMaxAllowedPrice(quality_score, remaining_budget_usdc);

  // LLM for safe explanation only
  const result = await generateStructuredJson<z.infer<typeof ValueAllocatorSchema>>({
    agentName: "value_allocator",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source URL: ${source_url}\nTitle: ${source_title}\nQuality score: ${quality_score}\nRemaining budget: ${remaining_budget_usdc} USDC\nMax allowed price (computed): ${maxAllowedPrice} USDC\n\nEvaluate ROI and worth. Return structured JSON only.`,
    schema: ValueAllocatorSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic only, no LLM explanation
    return {
      ok: true,
      serviceName: "value_allocator",
      data: {
        roi_score: quality_score,
        estimated_value: maxAllowedPrice,
        worth_label: quality_score >= 0.7 ? "medium" : "low",
        max_allowed_price: maxAllowedPrice,
        safe_value_summary: `Quality: ${quality_score.toFixed(2)}, max price: ${maxAllowedPrice.toFixed(6)} USDC (deterministic).`,
      },
      safeSummary: `Quality: ${quality_score.toFixed(2)}, max price: ${maxAllowedPrice.toFixed(6)} USDC (deterministic).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "value_allocator",
    data: {
      roi_score: result.data.roi_score,
      estimated_value: result.data.estimated_value,
      worth_label: result.data.worth_label,
      max_allowed_price: maxAllowedPrice,
      safe_value_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
