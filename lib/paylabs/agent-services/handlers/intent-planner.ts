/**
 * Intent Planner Handler
 *
 * Reuses: tutor_intake + intent_classifier
 * Macro-node: discovery_planner
 * Execution modes:
 *   - deterministic (default): rule-based classification from keywords
 *   - llm: LLM-powered intent classification
 *   - hybrid: deterministic + LLM explanation
 *
 * Output: normalized_goal, intent_type, constraints, route_tier_hint, safe_intent_summary
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const IntentPlannerSchema = z.object({
  cleaned_goal: z.string(),
  intent_type: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  constraints: z.array(z.string()),
  route_tier_hint: z.enum(["easy", "normal", "advanced"]),
  risk_notes: z.array(z.string()),
  safe_summary: z.string(),
});

// ─── Deterministic Intent Classification ────────────────────

const INTENT_KEYWORDS: Record<string, string[]> = {
  source_path_request: ["find", "discover", "search", "source", "article", "paper", "feed", "content", "research", "news", "blog", "rss"],
  source_payment_request: ["pay", "buy", "purchase", "subscribe", "access", "unlock", "premium", "paid"],
  creator_dashboard_request: ["dashboard", "creator", "earnings", "revenue", "analytics", "stats", "report"],
  creator_claim_request: ["claim", "verify", "ownership", "wallet", "connect", "register"],
};

function classifyIntentDeterministic(goal: string): string {
  const lower = goal.toLowerCase();
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return intent;
  }
  return "source_path_request";
}

function suggestTierFromBudget(_budgetUsdc: number): "easy" | "normal" | "advanced" {
  // Removed: tier must come from controller, not budget.
  // Kept as no-op for backward compat; callers should use resolveRouteTierHint.
  return "easy";
}

function resolveRouteTierHint(routeTier?: DelegatedRouteTier): "easy" | "normal" | "advanced" {
  if (routeTier === "easy" || routeTier === "normal" || routeTier === "advanced") {
    return routeTier;
  }
  return "easy";
}

function extractConstraints(goal: string): string[] {
  const constraints: string[] = [];
  const lower = goal.toLowerCase();
  if (lower.includes("recent") || lower.includes("latest")) constraints.push("recency_priority");
  if (lower.includes("verified") || lower.includes("trusted")) constraints.push("trust_required");
  if (lower.includes("free") || lower.includes("no cost")) constraints.push("free_only");
  if (lower.includes("premium") || lower.includes("high quality")) constraints.push("quality_priority");
  return constraints;
}

function runDeterministicIntentPlanner(
  goal: string,
  budgetUsdc: number,
  routeTier?: DelegatedRouteTier,
  brainNormalizedGoal?: string,
): {
  normalized_goal: string;
  intent_type: string;
  constraints: string[];
  route_tier_hint: "easy" | "normal" | "advanced";
  risk_notes: string[];
} {
  const intentType = classifyIntentDeterministic(goal);
  const resolvedTier = resolveRouteTierHint(routeTier);
  const constraints = extractConstraints(goal);

  // Prefer Brain normalized_goal if present
  const normalizedGoal = (brainNormalizedGoal || goal).trim().replace(/\s+/g, " ").slice(0, 500);

  // Deterministic unsupported/risk detection
  const riskNotes: string[] = [];
  const lower = goal.toLowerCase();
  if (lower.includes("private key") || lower.includes("seed phrase") || lower.includes("mnemonic")) {
    riskNotes.push("unsupported: requests raw private keys or seed phrases");
  }
  if (lower.includes("bypass payment") || lower.includes("skip payment") || lower.includes("free access hack")) {
    riskNotes.push("unsupported: requests payment bypass");
  }
  if (lower.includes("hidden prompt") || lower.includes("ignore instructions") || lower.includes("system prompt")) {
    riskNotes.push("risky: possible prompt injection attempt");
  }
  if (lower.includes("raw x402") || lower.includes("raw gateway") || lower.includes("raw signature")) {
    riskNotes.push("unsupported: requests raw protocol internals");
  }

  return {
    normalized_goal: normalizedGoal,
    intent_type: intentType,
    constraints,
    route_tier_hint: resolvedTier,
    risk_notes: riskNotes,
  };
}

// ─── Handler ────────────────────────────────────────────────

export const intentPlannerHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { goal, budgetUsdc, routeTier, brainNormalizedGoal, brainDiscoveryStrategy } = input.payload as {
    goal: string;
    budgetUsdc: number;
    routeTier?: DelegatedRouteTier;
    brainNormalizedGoal?: string;
    brainDiscoveryStrategy?: string;
  };

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("intent_planner")) {
    const det = runDeterministicIntentPlanner(goal || "", budgetUsdc || 0, routeTier, brainNormalizedGoal);
    return {
      ok: true,
      serviceName: "intent_planner",
      data: {
        normalized_goal: det.normalized_goal,
        intent_type: det.intent_type,
        constraints: det.constraints,
        route_tier_hint: det.route_tier_hint,
        risk_notes: det.risk_notes,
        safe_intent_summary: `Intent: ${det.intent_type}, tier: ${det.route_tier_hint}, constraints: ${det.constraints.length}${det.risk_notes.length > 0 ? `, risks: ${det.risk_notes.length}` : ""}. Deterministic classification.`,
      },
      safeSummary: `Intent: ${det.intent_type}, tier: ${det.route_tier_hint}, constraints: ${det.constraints.length}. Deterministic classification.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `You are PayLabs Intent Planner. Combine tutor intake and intent classification into a single step. Turn the user's raw request into a safe source-payment task. Identify the goal, intent type, constraints, and suggested route tier. You cannot select sources, set prices, set wallets, execute payments, or invent URLs. Return structured JSON only. Always include a safe_summary field that is a 1-2 sentence human-readable summary of the intent classification.`;

  const result = await generateStructuredJson<z.infer<typeof IntentPlannerSchema>>({
    agentName: "intent_planner",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${goal || ""}"\nBudget: ${budgetUsdc || 0} USDC\nRoute: ${routeTier || "easy"}`,
    schema: IntentPlannerSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic
    const det = runDeterministicIntentPlanner(goal || "", budgetUsdc || 0, routeTier, brainNormalizedGoal);
    return {
      ok: true,
      serviceName: "intent_planner",
      data: {
        normalized_goal: det.normalized_goal,
        intent_type: det.intent_type,
        constraints: det.constraints,
        route_tier_hint: det.route_tier_hint,
        safe_intent_summary: `Intent: ${det.intent_type}, tier: ${det.route_tier_hint} (LLM failed, deterministic fallback).`,
      },
      safeSummary: `Intent: ${det.intent_type}, tier: ${det.route_tier_hint} (LLM failed, deterministic fallback).`,
      settled: false,
      error: null,
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
