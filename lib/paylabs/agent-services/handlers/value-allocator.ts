/**
 * Value Allocator Handler
 *
 * Reuses: budget_optimizer + payment_quote
 * Macro-node: payment_decision
 *
 * Execution modes:
 *   - deterministic (default): budget math only, no LLM
 *   - hybrid: deterministic budget math + LLM for safe explanation
 *   - llm: LLM may assist ROI evaluation, budget math is source of truth
 *
 * Budget math is MANDATORY deterministic in all modes.
 * LLM only for safe explanation/summary (never for price/budget decisions).
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import {
  shouldRunServiceAsDeterministic,
  shouldRunServiceAsHybrid,
} from "../execution-mode";

const ValueAllocatorSchema = z.object({
  roi_score: z.number().min(0).max(1),
  estimated_value: z.number().min(0),
  worth_label: z.enum(["high", "medium", "low", "skip"]),
  explanation: z.string(),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Value Allocator.
Your task is to produce a short safe explanation of source value using already-computed deterministic budget math.
You must not change:
max_allowed_price
estimated_value
final price
budget limits
payment approval
settlement status
The backend deterministic math is the source of truth.
You may explain:
why a source appears high/medium/low value
how quality score relates to budget usefulness
why it should be skipped if quality is low
You cannot set prices. You cannot override the quote engine. You cannot approve payments. You cannot execute payments. You cannot settle payments. You cannot invent tx hashes or payment refs.
safe_summary must be 1 short sentence.
Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{".`;

// ─── Deterministic Budget Math ──────────────────────────────

function computeMaxAllowedPrice(
  qualityScore: number,
  remainingBudgetUsdc: number
): number {
  // Max 20% of remaining budget per item, capped at quality-proportional amount
  const maxByBudget = remainingBudgetUsdc * 0.2;
  const maxByQuality = qualityScore * 0.01; // quality 0-1 maps to 0-0.01 USDC
  return Math.min(maxByBudget, maxByQuality);
}

function computeDeterministicRoi(qualityScore: number, maxPrice: number): number {
  if (maxPrice <= 0) return 0;
  return Math.min(1, qualityScore / (maxPrice * 100));
}

function classifyWorth(qualityScore: number): "high" | "medium" | "low" | "skip" {
  if (qualityScore >= 0.8) return "high";
  if (qualityScore >= 0.5) return "medium";
  if (qualityScore >= 0.2) return "low";
  return "skip";
}

function runDeterministicValueAllocator(
  qualityScore: number,
  remainingBudgetUsdc: number
): {
  roi_score: number;
  estimated_value: number;
  max_allowed_price: number;
  worth_label: "high" | "medium" | "low" | "skip";
  safe_summary: string;
} {
  const maxAllowedPrice = computeMaxAllowedPrice(qualityScore, remainingBudgetUsdc);
  const roiScore = computeDeterministicRoi(qualityScore, maxAllowedPrice);
  const worthLabel = classifyWorth(qualityScore);
  const safeSummary = `Quality: ${qualityScore.toFixed(2)}, ROI: ${roiScore.toFixed(2)}, max price: ${maxAllowedPrice.toFixed(6)} USDC, worth: ${worthLabel}. Deterministic.`;

  return {
    roi_score: roiScore,
    estimated_value: maxAllowedPrice,
    max_allowed_price: maxAllowedPrice,
    worth_label: worthLabel,
    safe_summary: safeSummary,
  };
}

// ─── Handler ────────────────────────────────────────────────

export const valueAllocatorHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const remainingBudgetUsdc = (input.payload as { remaining_budget_usdc?: number }).remaining_budget_usdc ?? 0;
  const routeTier = (input.payload as { routeTier?: DelegatedRouteTier }).routeTier;

  // ── Batch mode: payload.candidates is an array ──
  const candidates = (input.payload as {
    candidates?: Array<{ feed_item_id: string; source_url: string; source_title: string; quality_score: number }>
  }).candidates;

  if (Array.isArray(candidates)) {
    const results: Array<{
      feed_item_id: string;
      roi_score: number;
      estimated_value: number;
      max_allowed_price: number;
      worth_label: "high" | "medium" | "low" | "skip";
      safe_value_summary: string;
    }> = [];

    for (const c of candidates) {
      const det = runDeterministicValueAllocator(c.quality_score ?? 0, remainingBudgetUsdc);
      results.push({
        feed_item_id: c.feed_item_id,
        roi_score: det.roi_score,
        estimated_value: det.estimated_value,
        max_allowed_price: det.max_allowed_price,
        worth_label: det.worth_label,
        safe_value_summary: det.safe_summary,
      });
    }

    const summary = `Value Allocator batch: ${results.length} candidates, ${results.filter(r => r.worth_label !== "skip").length} worth evaluating.`;
    return {
      ok: true,
      serviceName: "value_allocator",
      data: { results },
      safeSummary: summary,
      settled: false,
      error: null,
    };
  }

  // ── Single-item mode (backward compatible) ──
  const { source_url, source_title, quality_score } =
    input.payload as {
      source_url: string;
      source_title: string;
      quality_score: number;
    };

  // ── Deterministic budget math (always runs, source of truth) ──
  const det = runDeterministicValueAllocator(quality_score, remainingBudgetUsdc);

  // ── Deterministic mode: no LLM ──
  if (shouldRunServiceAsDeterministic("value_allocator")) {
    return {
      ok: true,
      serviceName: "value_allocator",
      data: {
        roi_score: det.roi_score,
        estimated_value: det.estimated_value,
        worth_label: det.worth_label,
        max_allowed_price: det.max_allowed_price,
        safe_value_summary: det.safe_summary,
      },
      safeSummary: det.safe_summary,
      settled: false,
      error: null,
    };
  }

  // ── Hybrid or LLM mode: use LLM for explanation ──
  const { generateStructuredJson } = await import("@/lib/paylabs/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const result = await generateStructuredJson<z.infer<typeof ValueAllocatorSchema>>({
    agentName: "value_allocator",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source URL: ${source_url}\nTitle: ${source_title}\nQuality score: ${quality_score}\nRemaining budget: ${remainingBudgetUsdc} USDC\nMax allowed price (computed): ${det.max_allowed_price} USDC\n\nEvaluate ROI and worth. Return structured JSON only.`,
    schema: ValueAllocatorSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic only (budget math is always source of truth)
    return {
      ok: true,
      serviceName: "value_allocator",
      data: {
        roi_score: det.roi_score,
        estimated_value: det.estimated_value,
        worth_label: det.worth_label,
        max_allowed_price: det.max_allowed_price,
        safe_value_summary: `${det.safe_summary} (LLM failed, deterministic fallback)`,
      },
      safeSummary: `${det.safe_summary} (LLM failed, deterministic fallback)`,
      settled: false,
      error: null,
    };
  }

  // LLM result for explanation only — budget math (max_allowed_price) is always deterministic
  return {
    ok: true,
    serviceName: "value_allocator",
    data: {
      roi_score: det.roi_score, // deterministic source of truth
      estimated_value: det.estimated_value, // deterministic source of truth
      worth_label: shouldRunServiceAsHybrid("value_allocator")
        ? det.worth_label // hybrid: deterministic label is source of truth
        : result.data.worth_label, // llm: LLM may suggest label
      max_allowed_price: det.max_allowed_price, // always deterministic
      safe_value_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
