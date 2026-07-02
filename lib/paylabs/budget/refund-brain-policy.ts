/**
 * Brain Refund Policy — Advisory Only
 *
 * Brain receives safe budget context after route completion.
 * Brain returns a recommendation (never executes refunds).
 *
 * Brain MUST NOT receive:
 * - raw x402 headers
 * - raw payment signatures
 * - raw Gateway responses
 * - private keys / wallet secrets
 * - raw receipt payloads
 * - raw chain-of-thought
 *
 * Brain MUST NOT claim:
 * - refund completed
 * - funds returned
 * - tx hash
 * - Gateway success
 * - x402 settled
 */

import type {
  BrainRefundRecommendation,
  BrainRefundRecommendationAction,
} from "../delegated-runtime/types";
import type { BrainSafeRefundContext } from "./refund-reconciliation";
import { z } from "zod";

// ─── Zod Schema for Brain Refund Recommendation ─────────────

const BrainRefundSchema = z.object({
    action: z.enum([
      "refund_not_required",
      "request_refund",
      "hold_pending_settlement",
      "manual_review",
    ]),
    safe_reason: z.string().min(1).max(500),
    requested_refund_usdc: z.number().min(0).nullable().optional(),
  });

// ─── Brain Refund System Prompt ─────────────────────────────

const BRAIN_REFUND_SYSTEM_PROMPT = `
You are PayLabs Brain — refund recommendation advisor.

Your role is RECOMMENDATION ONLY. You do NOT execute refunds.
You do NOT have access to wallets, payment rails, or settlement systems.

You receive a safe budget context with:
- route tier and run status
- planned cost, upfront payment, settled amounts
- pending settlement amounts
- maximum refundable amount
- wallet verification status

You return ONE recommendation:
- "refund_not_required" — no refund needed
- "request_refund" — refund should be processed
- "hold_pending_settlement" — wait for settlements to complete
- "manual_review" — needs human review

RULES:
- If paidUpfrontUsdc <= 0: action MUST be "refund_not_required"
- If maxRefundableUsdc <= 0: action MUST be "refund_not_required"
- If pendingSettlementUsdc > 0: action MUST be "hold_pending_settlement"
- If walletVerified is false: action MUST be "manual_review"
- If paidUpfrontUsdc > actualSettledUsdc AND maxRefundableUsdc > 0 AND walletVerified is true: action SHOULD be "request_refund"

You MUST NOT:
- Claim a refund has been completed
- Claim funds have been returned
- Invent or reference tx hashes
- Claim Gateway success
- Claim x402 settled
- Access raw payment data
- Execute any financial operation

OUTPUT:
Return JSON only. No markdown fences. No commentary.
The first character must be "{".

{
  "action": "refund_not_required",
  "safe_reason": "No upfront debit was captured, so there is no refund to execute.",
  "requested_refund_usdc": null
}
`;

// ─── Get Brain Refund Recommendation ────────────────────────

/**
 * Ask Brain for a refund recommendation given safe context.
 * Returns null if Brain call fails (fail-soft).
 */
export async function getBrainRefundRecommendation(
  safeContext: BrainSafeRefundContext
): Promise<BrainRefundRecommendation | null> {
  try {
    const { generateStructuredJson } = await import("../ai/llm-structured");

    const result = await generateStructuredJson({
      agentName: "brain_refund_advisor",
      routeTier: "normal",
      systemPrompt: BRAIN_REFUND_SYSTEM_PROMPT,
      userPrompt: buildRefundUserPrompt(safeContext),
      schema: BrainRefundSchema,
    });

    if (!result.ok) {
      return null;
    }

    const data = result.data as {
      action: string;
      safe_reason: string;
      requested_refund_usdc?: number | null;
    };

    // Validate action is one of the allowed values
    const allowedActions: BrainRefundRecommendationAction[] = [
      "refund_not_required",
      "request_refund",
      "hold_pending_settlement",
      "manual_review",
    ];

    if (!allowedActions.includes(data.action as BrainRefundRecommendationAction)) {
      return null;
    }

    return {
      action: data.action as BrainRefundRecommendationAction,
      safe_reason: data.safe_reason || "Brain provided recommendation",
      requested_refund_usdc: data.requested_refund_usdc ?? null,
    };
  } catch {
    // Fail-soft: Brain recommendation failure does not block reconciliation
    return null;
  }
}

// ─── Prompt Builder ─────────────────────────────────────────

function buildRefundUserPrompt(ctx: BrainSafeRefundContext): string {
  return `Budget refund context after route completion:

Route tier: ${ctx.routeTier}
Run status: ${ctx.runStatus}
Planned cost: ${ctx.plannedCostUsdc.toFixed(6)} USDC
Paid upfront: ${ctx.paidUpfrontUsdc.toFixed(6)} USDC
Actual settled: ${ctx.actualSettledUsdc.toFixed(6)} USDC
Estimated unsettled: ${ctx.estimatedUnsettledUsdc.toFixed(6)} USDC
Pending settlement: ${ctx.pendingSettlementUsdc.toFixed(6)} USDC
Max refundable: ${ctx.maxRefundableUsdc.toFixed(6)} USDC
Wallet verified: ${ctx.walletVerified}

Based on this context, should a refund be requested? Return JSON only.`;
}
