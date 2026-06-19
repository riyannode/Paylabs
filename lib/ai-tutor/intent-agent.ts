/**
 * Agent 1: Intent Agent
 * Normalizes user's goal and budget into a safe planning intent.
 * No payment, no Runner, no Circle — read-only.
 *
 * Uses LLM (ChatOpenAI + structured output) when available.
 * Falls back to deterministic keyword extraction if no API key or LLM fails.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { getTutorModel, getTutorModelName } from "./llm";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createHash } from "node:crypto";

// ─── Zod schema for LLM structured output ───────────────────────

const IntentSchema = z.object({
  normalized_goal: z.string().describe("The cleaned, normalized learning goal"),
  topics: z.array(z.string()).describe("List of relevant topic keywords extracted from the goal"),
  learning_level: z.enum(["beginner", "intermediate", "advanced"]).describe("Inferred learning level"),
  risk_notes: z.array(z.string()).describe("Any risk notes about the goal or budget"),
});

type IntentResult = z.infer<typeof IntentSchema>;

// ─── LLM path ───────────────────────────────────────────────────

async function runIntentLLM(
  goal: string,
  budgetUsdc: number,
  tier: RouteTier,
  prompt: string
): Promise<IntentResult | null> {
  const model = getTutorModel();
  if (!model) return null;

  try {
    const structuredModel = model.withStructuredOutput(IntentSchema);

    const result = await structuredModel.invoke([
      new SystemMessage(prompt),
      new HumanMessage(
        `User goal: "${goal}"\nBudget: ${budgetUsdc} USDC\nRoute tier: ${tier}\n\nExtract the normalized intent.`
      ),
    ]);

    return result as IntentResult;
  } catch {
    return null;
  }
}

// ─── Deterministic fallback ─────────────────────────────────────

function runIntentDeterministic(
  goal: string,
  budgetUsdc: number,
  tier: RouteTier
): IntentResult {
  const normalizedGoal = goal.trim().toLowerCase().replace(/\s+/g, " ");

  const topicKeywords = [
    "x402", "nanopayment", "gateway", "arc", "erc8004", "erc8183",
    "creator", "monetization", "revenue", "split", "receipt",
    "agent", "autonomous", "budget", "policy",
    "payment", "settlement", "wallet", "circle",
    "subscription", "pay-per-piece", "content",
    "learning", "education", "course", "lesson",
  ];

  const premiumAdvancedKeywords = [
    "architecture", "safety", "trust", "boundary", "payout",
    "implementation", "integration", "deployment", "testing",
  ];

  let allKeywords = topicKeywords;
  if (tier === "premium" || tier === "advanced") {
    allKeywords = [...topicKeywords, ...premiumAdvancedKeywords];
  }

  const topics = allKeywords.filter((k) => normalizedGoal.includes(k));
  if (topics.length === 0) topics.push("general-learning");

  let learningLevel: "beginner" | "intermediate" | "advanced" = "beginner";
  if (tier === "premium") learningLevel = "advanced";
  else if (tier === "advanced") learningLevel = "intermediate";

  if (
    normalizedGoal.includes("advanced") ||
    normalizedGoal.includes("erc8183") ||
    normalizedGoal.includes("arclayer")
  ) {
    learningLevel = "advanced";
  } else if (
    normalizedGoal.includes("intermediate") ||
    normalizedGoal.includes("x402") ||
    normalizedGoal.includes("agent")
  ) {
    if (tier !== "premium") learningLevel = "intermediate";
  }

  const riskNotes: string[] = [];
  if (budgetUsdc < 0.001) riskNotes.push("Budget very low — may not find lessons");
  if (budgetUsdc > 0.1) riskNotes.push("Budget above typical range");
  if (tier === "premium" && budgetUsdc < 0.02) {
    riskNotes.push("Premium route with very low budget — may not fill all 8 lesson slots");
  }

  return {
    normalized_goal: normalizedGoal,
    topics,
    learning_level: learningLevel,
    risk_notes: riskNotes,
  };
}

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

  // Try LLM first, fallback to deterministic
  let llmResult = await runIntentLLM(goal, budgetUsdc, tier, prompts.intent);
  let mode: "llm" | "deterministic_fallback" = "llm";

  if (!llmResult) {
    llmResult = runIntentDeterministic(goal, budgetUsdc, tier);
    mode = "deterministic_fallback";
  }

  const promptText = prompts.intent;
  const promptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);

  const trace: Record<string, unknown> = {
    agent: "intent_agent",
    mode,
    route_tier: tier,
    prompt_persona: `${tier}_intent`,
    prompt_hash: promptHash,
    reasoning_depth: config.reasoningDepth,
    topics_found: llmResult.topics.length,
    learning_level: llmResult.learning_level,
  };

  if (mode === "llm") {
    trace.model = getTutorModelName();
  }

  return {
    normalizedGoal: llmResult.normalized_goal,
    topics: llmResult.topics,
    learningLevel: llmResult.learning_level,
    maxLessonPriceUsdc,
    riskNotes: llmResult.risk_notes,
    pathStatus: "none",
    routeConfig: config as unknown as Record<string, unknown>,
    agentTrace: { intent: trace },
  };
}
