/**
 * Agent 1: Intent Agent
 * Normalizes user's goal and budget into a safe planning intent.
 * No payment, no Runner, no Circle — read-only.
 * Route tier affects topic extraction depth and learning level inference.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { createHash } from "node:crypto";

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

  // Normalize goal
  const normalizedGoal = goal.trim().toLowerCase().replace(/\s+/g, " ");

  // Extract topics from goal — depth varies by route tier
  const topicKeywords = [
    "x402", "nanopayment", "gateway", "arc", "erc8004", "erc8183",
    "creator", "monetization", "revenue", "split", "receipt",
    "agent", "autonomous", "budget", "policy",
    "payment", "settlement", "wallet", "circle",
    "subscription", "pay-per-piece", "content",
    "learning", "education", "course", "lesson",
  ];

  // Premium and Advanced extract more topics
  const premiumAdvancedKeywords = [
    "architecture", "safety", "trust", "boundary", "payout",
    "implementation", "integration", "deployment", "testing",
  ];

  let allKeywords = topicKeywords;
  if (tier === "premium" || tier === "advanced") {
    allKeywords = [...topicKeywords, ...premiumAdvancedKeywords];
  }

  const topics = allKeywords.filter((k) => normalizedGoal.includes(k));
  if (topics.length === 0) {
    topics.push("general-learning");
  }

  // Infer level — route tier biases the default
  let learningLevel: "beginner" | "intermediate" | "advanced" = "beginner";
  if (tier === "premium") {
    learningLevel = "advanced";
  } else if (tier === "advanced") {
    learningLevel = "intermediate";
  }

  // Override if goal explicitly mentions level
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

  const maxLessonPriceUsdc = Number(
    process.env.PAYLABS_MAX_LESSON_PRICE_USDC || "0.05"
  );

  const riskNotes: string[] = [];
  if (budgetUsdc < 0.001) riskNotes.push("Budget very low — may not find lessons");
  if (budgetUsdc > 0.1) riskNotes.push("Budget above typical range");
  if (tier === "premium" && budgetUsdc < 0.02) {
    riskNotes.push("Premium route with very low budget — may not fill all 8 lesson slots");
  }

  // Build agent trace — record which prompt persona was used
  const promptText = prompts.intent;
  const promptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);
  const trace: Record<string, unknown> = {
    agent: "intent_agent",
    route_tier: tier,
    prompt_persona: `${tier}_intent`,
    prompt_hash: promptHash,
    reasoning_depth: config.reasoningDepth,
    topics_found: topics.length,
    learning_level: learningLevel,
  };

  return {
    normalizedGoal,
    topics,
    learningLevel,
    maxLessonPriceUsdc,
    riskNotes,
    pathStatus: "none",
    routeConfig: config as unknown as Record<string, unknown>,
    agentTrace: { intent: trace },
  };
}
