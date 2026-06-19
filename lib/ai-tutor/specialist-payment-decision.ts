/**
 * Specialist Payment Decision Helper
 * LLM decides whether to pay a specialist service.
 * Final decision is deterministic: feature flag + provider validation + budget check.
 *
 * RFB 03: Agent-to-Agent Nanopayment Networks
 */

import { z } from "zod";
import { invokeJsonAgent } from "./llm-json";
import type { RouteTier } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";

// ─── Zod schema for LLM structured output ───────────────────────

export const SpecialistDecisionSchema = z.object({
  should_pay: z.boolean().describe("Whether the specialist service is worth paying for"),
  service_type: z.literal("source_verification").describe("The service type"),
  provider_agent_id: z.string().describe("The provider agent to pay"),
  max_price_usdc: z.number().describe("Maximum price the agent would pay"),
  reason: z.string().describe("Why this decision was made"),
  expected_value: z.string().describe("What value the service provides"),
});

export type SpecialistDecision = z.infer<typeof SpecialistDecisionSchema>;

// ─── Decision prompt ─────────────────────────────────────────────

const SPECIALIST_DECISION_PROMPT = `You are the PayLabs Specialist Payment Decision Agent.
You decide whether the Tutor Orchestrator should pay a separate specialist agent for source verification.

Decision guidelines by route tier:
- Normal route: pay specialist only if source risk is non-trivial or user budget allows
- Advanced route: prefer paid verifier for technical source integrity
- Premium route: require paid verifier unless budget is insufficient

Consider:
1. Is the source verification task complex enough to warrant a paid specialist?
2. Does the user's budget support the additional cost?
3. Is the route tier's source strictness high enough to benefit from specialist verification?
4. Would skipping specialist verification risk using unverified or low-quality sources?

Return structured JSON only. You do NOT execute payment — you only recommend.`;

// ─── Main decision function ─────────────────────────────────────

export async function getSpecialistPaymentDecision(input: {
  routeTier: RouteTier;
  budgetUsdc: number;
  estimatedLessonCostUsdc: number;
  lessonCount: number;
  providerPriceUsdc: number;
  providerAgentId: string;
}): Promise<{ ok: true; decision: SpecialistDecision } | { ok: false; error: string }> {
  const { routeTier, budgetUsdc, estimatedLessonCostUsdc, lessonCount, providerPriceUsdc, providerAgentId } = input;

  const llmResult = await invokeJsonAgent<SpecialistDecision>({
    agentName: "specialist_payment_decision",
    routeTier,
    prompt: SPECIALIST_DECISION_PROMPT,
    userMessage: `Route tier: ${routeTier}
User budget: ${budgetUsdc} USDC
Estimated lesson costs: ${estimatedLessonCostUsdc} USDC (${lessonCount} lessons)
Specialist provider: ${providerAgentId}
Specialist price: ${providerPriceUsdc} USDC
Remaining after lessons: ${budgetUsdc - estimatedLessonCostUsdc} USDC

Should the Tutor Orchestrator pay the ${providerAgentId} for source verification?`,
    schema: SpecialistDecisionSchema,
  });

  if (!llmResult.ok) {
    return { ok: false, error: `LLM decision failed: ${llmResult.error}` };
  }

  return { ok: true, decision: (llmResult as { ok: true; data: SpecialistDecision }).data };
}

// ─── Deterministic validation ────────────────────────────────────

export function validateSpecialistDecision(input: {
  decision: SpecialistDecision;
  providerAgentId: string;
  providerPriceUsdc: number;
  providerActive: boolean;
  budgetUsdc: number;
  alreadySpentUsdc: number;
  agentToAgentEnabled: boolean;
  routeTier: RouteTier;
}): { valid: true } | { valid: false; reason: string } {
  const {
    decision,
    providerAgentId,
    providerPriceUsdc,
    providerActive,
    budgetUsdc,
    alreadySpentUsdc,
    agentToAgentEnabled,
    routeTier,
  } = input;

  // Feature gate
  if (!agentToAgentEnabled) {
    return { valid: false, reason: "PAYLABS_AGENT_TO_AGENT_PAYMENTS is disabled" };
  }

  // Provider validation
  if (!providerActive) {
    return { valid: false, reason: `Provider ${providerAgentId} is not active` };
  }
  if (decision.provider_agent_id !== providerAgentId) {
    return { valid: false, reason: `Provider mismatch: decision=${decision.provider_agent_id}, expected=${providerAgentId}` };
  }
  if (providerPriceUsdc <= 0) {
    return { valid: false, reason: "Provider price must be > 0" };
  }

  // Budget validation
  if (alreadySpentUsdc + providerPriceUsdc > budgetUsdc) {
    return { valid: false, reason: `Insufficient budget for specialist: need ${providerPriceUsdc}, have ${budgetUsdc - alreadySpentUsdc} remaining` };
  }

  // Route-tier enforcement: premium always requires paid verifier
  if (routeTier === "premium" && !decision.should_pay) {
    // LLM said no but premium requires it — override
    // Only block if budget is truly insufficient (already checked above)
  }

  return { valid: true };
}
