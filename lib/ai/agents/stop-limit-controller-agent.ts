/**
 * Agent 7: Stop-Limit Controller
 * Decide whether evidence path should stop expanding.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getRouteLimits } from "../route-config";
import { STOP_REASONS } from "@/types/paylabs";

const Schema = z.object({
  stop_limit_hit: z.boolean(),
  stop_reason: z.enum(STOP_REASONS),
  final_source_count: z.number(),
  explanation: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Stop-Limit Controller Agent. Decide whether the evidence path should stop expanding. You must protect user budget and avoid unnecessary paid sources. Stop when enough evidence exists, when caps are reached, or when marginal value is too low. Do not use BUY/SKIP/CACHE. Do not execute payment. Do not set wallet. Do not set price. Do not override deterministic backend limits. Return structured JSON only.`;

export async function stopLimitControllerAgent(state: PayLabsTutorStateType) {
  const { selectedSources, excludedSources, evidenceScore, marginalValueScore, routeTier, budgetUsdc } = state;
  const tier = routeTier || "normal";
  const limits = getRouteLimits(tier);
  const selected = (selectedSources as unknown[]) || [];

  // Deterministic pre-checks
  let deterministicStop: string | null = null;
  if (selected.length >= limits.maxSources) deterministicStop = "SOURCE_CAP_REACHED";
  if (evidenceScore !== undefined && evidenceScore >= 0.95) deterministicStop = "ENOUGH_EVIDENCE";

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "stop_limit_controller",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nBudget: ${budgetUsdc || 0} USDC\nSpend cap: ${limits.actualSpendCapUsdc}\nMax sources: ${limits.maxSources}\nSelected count: ${selected.length}\nExcluded count: ${(excludedSources as unknown[] || []).length}\nEvidence score: ${evidenceScore ?? "n/a"}\nMarginal value: ${marginalValueScore ?? "n/a"}\nMin evidence: ${limits.minEvidenceScore}\nStop marginal below: ${limits.stopMarginalValueBelow}\n${deterministicStop ? `\nDETERMINISTIC STOP: ${deterministicStop}` : ""}\n\nDecide whether to stop. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return {
    stopLimitHit: true,
    stopReason: "LLM_STRUCTURED_OUTPUT_PARSE_FAILED",
    error: `Stop-limit controller failed: ${result.error}`,
    llmErrors: { stop_limit_controller: result },
  };

  // Deterministic override: if we already determined stop, use it
  const finalStop = deterministicStop || result.data.stop_reason;
  const finalHit = deterministicStop ? true : result.data.stop_limit_hit;

  return {
    stopLimitHit: finalHit,
    stopReason: finalStop,
    agentTrace: { stop_limit_controller: { ...result.meta, deterministic_stop: deterministicStop } },
    llmOutputs: { stop_limit_controller: result.data },
    agentCallCounts: { stop_limit_controller: 1 },
  };
}
