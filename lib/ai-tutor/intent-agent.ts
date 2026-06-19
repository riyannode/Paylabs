/**
 * Agent 1: Intent Agent (LLM-powered)
 * Normalizes user's goal and budget into a safe planning intent.
 * No payment, no Runner, no Circle — read-only.
 *
 * Calls actual LLM via invokeJsonAgent with route-specific prompt.
 * If PAYLABS_LLM_REQUIRED=true and LLM fails, returns error (no silent fallback).
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { getTutorModelName } from "./llm";
import { invokeJsonAgent } from "./llm-json";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const IntentSchema = z.object({
  normalized_goal: z.string().describe("The cleaned, normalized learning goal"),
  topics: z.array(z.string()).describe("List of relevant topic keywords extracted from the goal"),
  learning_level: z.enum(["beginner", "intermediate", "advanced"]).describe("Inferred learning level"),
  risk_notes: z.array(z.string()).describe("Any risk notes about the goal or budget"),
});

type IntentResult = z.infer<typeof IntentSchema>;

// ─── Main agent ─────────────────────────────────────────────────

export async function intentAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { goal, budgetUsdc, userWallet, routeTier, routePrompts } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  // Validate wallet
  if (!userWallet?.startsWith("0x") || userWallet.length !== 42) {
    return { error: "Invalid wallet address", riskNotes: ["Invalid wallet format"] };
  }

  // Validate budget
  if (!budgetUsdc || budgetUsdc <= 0) {
    return { error: "Budget must be positive", riskNotes: ["Invalid budget"] };
  }

  if (!goal?.trim()) {
    return { error: "Goal is required", riskNotes: ["Empty goal"] };
  }

  const maxLessonPriceUsdc = Number(
    process.env.PAYLABS_MAX_LESSON_PRICE_USDC || "0.05"
  );

  // Call LLM
  const llmResult = await invokeJsonAgent<IntentResult>({
    agentName: "intent",
    routeTier: tier,
    prompt: prompts.intent,
    userMessage: `User wallet: ${userWallet}\nGoal: "${goal}"\nBudget: ${budgetUsdc} USDC\nRoute tier: ${tier}\nRoute config: ${JSON.stringify(config)}\n\nNormalize the user's learning intent. Extract topics, learning level, and risk notes.`,
    schema: IntentSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    return {
      error: `Intent Agent LLM failed: ${errResult.error}`,
      riskNotes: ["LLM call failed"],
      llmErrors: { intent: errResult },
      agentTrace: { intent: errResult.meta },
    };
  }

  const data = (llmResult as { ok: true; data: IntentResult; meta: Record<string, unknown> }).data;
  const meta = (llmResult as { ok: true; data: IntentResult; meta: Record<string, unknown> }).meta;

  return {
    normalizedGoal: data.normalized_goal,
    topics: data.topics,
    learningLevel: data.learning_level,
    maxLessonPriceUsdc,
    riskNotes: data.risk_notes,
    pathStatus: "none",
    routeConfig: config as unknown as Record<string, unknown>,
    agentTrace: { intent: meta },
    llmOutputs: { intent: data },
  };
}
