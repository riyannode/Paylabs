/**
 * Intent Planner Handler
 *
 * Reuses: tutor_intake + intent_classifier
 * Macro-node: discovery_planner
 * Requires LLM: yes
 *
 * Combines tutor intake and intent classification into a single service call.
 * Output: normalized_goal, intent_type, constraints, route_tier_hint, safe_intent_summary
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const IntentPlannerSchema = z.object({
  cleaned_goal: z.string(),
  intent_type: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  constraints: z.array(z.string()),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  risk_notes: z.array(z.string()),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Intent Planner. Combine tutor intake and intent classification into a single step. Turn the user's raw request into a safe source-payment task. Identify the goal, intent type, constraints, and suggested route tier. You cannot select sources, set prices, set wallets, execute payments, or invent URLs. Return structured JSON only. Always include a safe_summary field that is a 1-2 sentence human-readable summary of the intent classification.`;

export const intentPlannerHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { goal, budgetUsdc, routeTier } = input.payload as {
    goal: string;
    budgetUsdc: number;
    routeTier?: DelegatedRouteTier;
  };

  const result = await generateStructuredJson<z.infer<typeof IntentPlannerSchema>>({
    agentName: "intent_planner",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${goal || ""}"\nBudget: ${budgetUsdc || 0} USDC\nRoute: ${routeTier || "easy"}`,
    schema: IntentPlannerSchema,
  });

  if (!result.ok) {
    return {
      ok: false,
      serviceName: "intent_planner",
      data: null,
      safeSummary: `Intent planner failed: ${result.error}`,
      settled: false,
      error: result.error,
    };
  }

  return {
    ok: true,
    serviceName: "intent_planner",
    data: {
      normalized_goal: result.data.cleaned_goal,
      intent_type: result.data.intent_type,
      constraints: result.data.constraints,
      route_tier_hint: result.data.route_tier_hint,
      safe_intent_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
