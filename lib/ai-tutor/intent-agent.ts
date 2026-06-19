/**
 * Agent 1: Intent Agent
 * Normalizes user's goal and budget into a safe planning intent.
 * No payment, no Runner, no Circle — read-only.
 */

import type { PayLabsTutorStateType } from "./state";

export async function intentAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { goal, budgetUsdc, userWallet } = state;

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

  // Extract topics from goal
  const topicKeywords = [
    "x402", "nanopayment", "gateway", "arc", "erc8004", "erc8183",
    "creator", "monetization", "revenue", "split", "receipt",
    "agent", "autonomous", "budget", "policy",
    "payment", "settlement", "wallet", "circle",
    "subscription", "pay-per-piece", "content",
    "learning", "education", "course", "lesson",
  ];
  const topics = topicKeywords.filter((k) => normalizedGoal.includes(k));
  if (topics.length === 0) {
    topics.push("general-learning");
  }

  // Infer level
  let learningLevel: "beginner" | "intermediate" | "advanced" = "beginner";
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
    learningLevel = "intermediate";
  }

  const maxLessonPriceUsdc = Number(
    process.env.PAYLABS_MAX_LESSON_PRICE_USDC || "0.05"
  );

  const riskNotes: string[] = [];
  if (budgetUsdc < 0.001) riskNotes.push("Budget very low — may not find lessons");
  if (budgetUsdc > 0.1) riskNotes.push("Budget above typical range");

  return {
    normalizedGoal,
    topics,
    learningLevel,
    maxLessonPriceUsdc,
    riskNotes,
    pathStatus: "none",
  };
}
