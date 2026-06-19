/**
 * Agent 15: Receipt Auditor Agent
 * Audit payment result and receipt consistency.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { supabaseAdmin } from "@/lib/supabase/server";

const Schema = z.object({
  receipt_ok: z.boolean(),
  audit_summary: z.string(),
  inconsistencies: z.array(z.string()),
  recommended_status: z.enum(["completed", "failed", "requires_manual_review"]),
});

const SYSTEM_PROMPT = `You are PayLabs Receipt Auditor Agent. Audit the payment result and receipt persistence. Check that the payment adapter result, DB receipt, source path item status, amount, split fields, and creator wallet are consistent. You cannot create fake receipt. You cannot repair payment proof. You cannot alter wallet/price. You cannot mark failed payment as completed. Return structured JSON only.`;

export async function receiptAuditorAgent(state: PayLabsTutorStateType) {
  const { sourcePaymentId, paymentAdapterResult, routeTier, userWallet, sourcePathId, sourcePathItemId } = state;
  const tier = routeTier || "normal";

  if (!sourcePaymentId) {
    return {
      receiptAudit: { receipt_ok: false, audit_summary: "No payment to audit", inconsistencies: ["sourcePaymentId missing"], recommended_status: "failed" },
      receiptId: undefined,
    };
  }

  // Load payment from DB
  const { data: payment } = await supabaseAdmin()
    .from("paylabs_source_payments")
    .select("*")
    .eq("id", sourcePaymentId)
    .single();

  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "receipt_auditor",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nUser: ${userWallet}\nSource path: ${sourcePathId}\nItem: ${sourcePathItemId}\n\nPayment adapter result:\n${JSON.stringify(paymentAdapterResult || {}, null, 2)}\n\nDB payment record:\n${JSON.stringify(payment || {}, null, 2)}\n\nAudit consistency. Return structured JSON only.`,
    schema: Schema,
  });

  if (!result.ok) return {
    receiptAudit: { receipt_ok: false, audit_summary: `Audit LLM failed: ${result.error}`, inconsistencies: ["LLM audit failed"], recommended_status: "requires_manual_review" },
    receiptId: sourcePaymentId,
    llmErrors: { receipt_auditor: result },
  };

  return {
    receiptAudit: result.data,
    receiptId: sourcePaymentId,
    agentTrace: { receipt_auditor: result.meta },
    llmOutputs: { receipt_auditor: result.data },
    agentCallCounts: { receipt_auditor: 1 },
  };
}
