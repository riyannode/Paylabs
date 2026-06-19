/**
 * Agent 1: Tutor Intake Agent
 * Clean user goal, suggest route. No DB writes, no source selection, no payment.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";

const Schema = z.object({
  cleaned_goal: z.string(),
  user_intent_hint: z.enum(["source_path_request", "source_payment_request", "creator_dashboard_request", "creator_claim_request", "unsupported"]),
  suggested_route_tier: z.enum(["normal", "advanced", "premium"]),
  user_visible_summary: z.string(),
  risk_notes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Tutor Intake Agent. Your job is to turn the user's raw request into a safe source-payment task. You must identify the user's goal, requested depth, rough topic area, and whether the request can be handled by PayLabs. You cannot select sources. You cannot set prices. You cannot set creator wallets. You cannot approve payments. You cannot call payment tools. You cannot invent source URLs. You cannot bypass budget limits. Return structured JSON only.`;

export async function tutorIntakeAgent(state: PayLabsTutorStateType) {
  const { goal, userWallet, budgetUsdc } = state;
  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "tutor_intake",
    routeTier: "normal",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `User wallet: ${userWallet}\nGoal: "${goal || ""}"\nBudget: ${budgetUsdc || 0} USDC`,
    schema: Schema,
  });
  if (!result.ok) return { error: `Tutor intake failed: ${result.error}`, llmErrors: { tutor_intake: result } };
  return {
    normalizedGoal: result.data.cleaned_goal,
    intent: result.data.user_intent_hint,
    riskNotes: result.data.risk_notes,
    agentTrace: { tutor_intake: result.meta },
    llmOutputs: { tutor_intake: result.data },
    agentCallCounts: { tutor_intake: 1 },
  };
}
