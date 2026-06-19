/**
 * Agent 2: Intent Classifier
 * Classify workflow intent, extract normalized goal/topics/constraints.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";

const Schema = z.object({
  intent: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  normalized_goal: z.string(),
  topics: z.array(z.string()),
  constraints: z.array(z.string()),
  learning_level: z.enum(["beginner", "intermediate", "advanced"]),
  risk_notes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Intent Classifier Agent. Classify the cleaned user goal into the exact PayLabs workflow. Extract topics and constraints. Keep the task RSSHub/source-payment oriented. You cannot select sources. You cannot set prices. You cannot set creator wallets. You cannot execute payment. You cannot create receipts. Return structured JSON only.`;

export async function intentClassifierAgent(state: PayLabsTutorStateType) {
  const { normalizedGoal, goal, budgetUsdc, routeTier } = state;
  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "intent_classifier",
    routeTier: routeTier || "normal",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalizedGoal || goal || ""}"\nBudget: ${budgetUsdc || 0} USDC\nRoute: ${routeTier || "normal"}`,
    schema: Schema,
  });
  if (!result.ok) return { error: `Intent classifier failed: ${result.error}`, llmErrors: { intent_classifier: result } };
  return {
    normalizedGoal: result.data.normalized_goal,
    topics: result.data.topics,
    constraints: result.data.constraints,
    learningLevel: result.data.learning_level,
    riskNotes: result.data.risk_notes,
    intent: result.data.intent,
    agentTrace: { intent_classifier: result.meta },
    llmOutputs: { intent_classifier: result.data },
    agentCallCounts: { intent_classifier: 1 },
  };
}
