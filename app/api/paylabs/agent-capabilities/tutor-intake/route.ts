// POST /api/paylabs/agent-capabilities/tutor-intake
//
// Paid agent capability endpoint for tutor_intake.
//
// TWO MODES (controlled by PAYLABS_AGENT_NANOPAYMENTS_ENABLED):
//
// Mode 1: Audit-only (flag = false, default)
//   - Validates HMAC-signed context
//   - Returns DB status (real execution via unified pipeline)
//
// Mode 2: Real x402 (flag = true)
//   - No payment header → returns 402 + PAYMENT-REQUIRED challenge
//   - Payment header present → verifies/settles via Circle x402
//   - Executes real tutor_intake agent logic
//   - Returns agent output + safe payment metadata

import { NextRequest } from "next/server";
import {
  validateAgentRequest,
  buildAgentResponse,
  buildAgentError,
  build402ChallengeResponse,
  verifyPaymentHeader,
  getAgentCapabilityStatus,
} from "@/lib/paylabs/agent-capability-helpers";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import {
  updateNanopaymentWithSafeRefs,
} from "@/lib/paylabs/nanopayment-service";

const AGENT_NAME = "tutor_intake" as const;

export async function POST(req: NextRequest) {
  const flags = getPaymentFlags();

  // ── Mode 2: x402 challenge if no payment header ─────────────
  if (flags.agentNanopaymentsEnabled) {
    const paymentHeader = req.headers.get("x-payment")
      ?? req.headers.get("PAYMENT-SIGNATURE");

    if (!paymentHeader) {
      // Return 402 with proper PAYMENT-REQUIRED challenge
      return build402ChallengeResponse(AGENT_NAME);
    }

    // ── Verify + settle the payment ───────────────────────────
    const verifyResult = await verifyPaymentHeader(paymentHeader, AGENT_NAME);

    if (!verifyResult.ok) {
      return buildAgentError(
        `Payment verification failed: ${verifyResult.error}`,
        402
      );
    }

    // ── Validate agent context (HMAC) ─────────────────────────
    const validation = validateAgentRequest(req, AGENT_NAME);
    if (!validation.valid) {
      return buildAgentError(validation.error, validation.status);
    }

    const { context } = validation;

    // ── Store safe payment refs in ledger ─────────────────────
    if (verifyResult.safePayment) {
      await updateNanopaymentWithSafeRefs(context.receipt_id, "running", {
        safePayment: verifyResult.safePayment,
      });
    }

    // ── Execute real agent logic ──────────────────────────────
    // For tutor_intake, the real execution happens via the unified
    // LangGraph pipeline. This endpoint acknowledges the payment
    // and returns the current DB status.
    //
    // Future: can inline agent execution here for standalone calls.
    try {
      const status = await getAgentCapabilityStatus(context);

      return buildAgentResponse({
        adapter: true,
        x402_settled: true,
        message: "Payment verified and settled via Circle Gateway x402",
        agent_name: AGENT_NAME,
        capability: "normalize_goal",
        receipt_id: context.receipt_id,
        receipt_url: context.receipt_url,
        amount_usdc: context.amount_usdc,
        db_status: status.status,
        payment: {
          settled: true,
          amount: verifyResult.safePayment?.amountAtomic,
          pay_to: verifyResult.safePayment?.payTo,
          network: verifyResult.safePayment?.network,
        },
      }, context);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return buildAgentError(`Agent error after payment: ${msg}`, 500);
    }
  }

  // ── Mode 1: Audit-only (original behavior) ──────────────────
  const validation = validateAgentRequest(req, AGENT_NAME);
  if (!validation.valid) {
    return buildAgentError(validation.error, validation.status);
  }

  const { context } = validation;

  try {
    const status = await getAgentCapabilityStatus(context);

    return buildAgentResponse({
      adapter: true,
      message: "This is a compatibility endpoint. Real execution via unified pipeline.",
      execution_path: "POST /api/paylabs/discovery-runs/pay",
      agent_name: AGENT_NAME,
      capability: "normalize_goal",
      receipt_id: context.receipt_id,
      receipt_url: context.receipt_url,
      amount_usdc: context.amount_usdc,
      db_status: status.status,
    }, context);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildAgentError(`Adapter error: ${msg}`, 500);
  }
}
