/**
 * Agent 13: Payment Quote Agent
 * Explain quote from DB/payment adapter. Cannot set price/wallet/proof.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";

const Schema = z.object({
  quote_summary: z.string(),
  user_facing_reason: z.string(),
  risk_flags: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Payment Quote Agent. Prepare a payment quote explanation using backend-provided source path item data. You cannot set price, wallet, source URL, or payment proof. The backend/payment adapter computes and validates all quote values. You cannot execute payment. You cannot create receipt. You cannot fake payment IDs. Return structured JSON only.`;

export async function paymentQuoteAgent(state: PayLabsTutorStateType) {
  const { policyDecision, routeTier, selectedSources, budgetUsdc } = state;
  const tier = routeTier || "normal";

  if (!policyDecision || !policyDecision.allowed) {
    return { paymentQuote: { allowed: false, reason: "Policy not approved" } };
  }

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "payment_quote_agent",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nBudget: ${budgetUsdc || 0} USDC\nSelected sources: ${(selectedSources as unknown[] || []).length}\nPolicy decision: ${JSON.stringify(policyDecision)}\n\nPrepare quote explanation. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return { error: `Payment quote failed: ${result.error}`, llmErrors: { payment_quote_agent: result } };

  return {
    paymentQuote: { ...result.data, allowed: true },
    agentTrace: { payment_quote_agent: result.meta },
    llmOutputs: { payment_quote_agent: result.data },
    agentCallCounts: { payment_quote_agent: 1 },
  };
}
