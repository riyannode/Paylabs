/**
 * Agent Capability Endpoint Validation
 *
 * Shared validation logic for all 7 paid agent capability endpoints.
 * Enforces 3 request headers and 3 response headers.
 *
 * Request headers:
 *   x-payment              — Gateway/x402 payment payload (disabled by flag)
 *   x-paylabs-agent-context — Signed compact JSON with agent context
 *   x-paylabs-receipt-link  — PayLabs receipt URL
 *
 * Response headers:
 *   x-payment-response     — Payment acknowledgement
 *   x-paylabs-agent-context — Echo back signed context
 *   x-paylabs-receipt-link  — Receipt URL
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAgentContext, type AgentContextPayload } from "@/lib/payments/agent-context";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import { updateNanopaymentStatus } from "@/lib/paylabs/nanopayment-service";
import type { PaidAgentName } from "@/lib/paylabs/agent-registry";

// ─── Constants ─────────────────────────────────────────────────

export const REQUEST_HEADERS = [
  "x-payment",
  "x-paylabs-agent-context",
  "x-paylabs-receipt-link",
] as const;

export const RESPONSE_HEADERS = [
  "x-payment-response",
  "x-paylabs-agent-context",
  "x-paylabs-receipt-link",
] as const;

// ─── Types ─────────────────────────────────────────────────────

export interface ValidatedAgentCall {
  valid: true;
  context: AgentContextPayload;
  receiptLink: string;
  paymentHeader: string | null;
}

export interface InvalidAgentCall {
  valid: false;
  error: string;
  status: number;
}

export type AgentCallValidation = ValidatedAgentCall | InvalidAgentCall;

// ─── Validation ────────────────────────────────────────────────

/**
 * Validate an incoming agent capability request.
 *
 * Checks:
 * 1. x-paylabs-agent-context present and valid JSON
 * 2. Signed context signature is valid
 * 3. Context is not expired
 * 4. Agent name matches expected
 * 5. Price is 0.000001
 * 6. x-paylabs-receipt-link present
 * 7. x-payment present when payments enabled (future)
 *
 * Returns validated context or error.
 */
export function validateAgentRequest(
  req: NextRequest,
  expectedAgentName: PaidAgentName
): AgentCallValidation {
  const flags = getPaymentFlags();

  // ── Check x-paylabs-agent-context (required) ─────────────────
  const contextHeader = req.headers.get("x-paylabs-agent-context");
  if (!contextHeader) {
    return {
      valid: false,
      error: "x-paylabs-agent-context header required",
      status: 400,
    };
  }

  // ── Verify signed context ────────────────────────────────────
  const verifyResult = verifyAgentContext(contextHeader, expectedAgentName);
  if (!verifyResult.valid) {
    return {
      valid: false,
      error: `Agent context invalid: ${verifyResult.error}`,
      status: 403,
    };
  }

  // ── Check x-paylabs-receipt-link (required) ──────────────────
  const receiptLink = req.headers.get("x-paylabs-receipt-link");
  if (!receiptLink) {
    return {
      valid: false,
      error: "x-paylabs-receipt-link header required",
      status: 400,
    };
  }

  // ── Check x-payment (required when payments enabled) ─────────
  const paymentHeader = req.headers.get("x-payment");
  if (flags.agentNanopaymentsEnabled && !paymentHeader) {
    return {
      valid: false,
      error: "x-payment header required when agent nanopayments enabled",
      status: 402,
    };
  }

  return {
    valid: true,
    context: verifyResult.payload!,
    receiptLink,
    paymentHeader,
  };
}

// ─── Response Builder ──────────────────────────────────────────

/**
 * Build response with 3 required response headers.
 */
export function buildAgentResponse(
  data: Record<string, unknown>,
  context: AgentContextPayload,
  status = 200
): NextResponse {
  const response = NextResponse.json(data, { status });

  // 3 response headers
  response.headers.set("x-payment-response", "ok");
  response.headers.set("x-paylabs-agent-context", JSON.stringify(context));
  response.headers.set("x-paylabs-receipt-link", context.receipt_url);

  return response;
}

/**
 * Build error response for agent capability endpoint.
 */
export function buildAgentError(
  error: string,
  status: number
): NextResponse {
  return NextResponse.json({ error }, { status });
}

// ─── Post-Validation Processing ────────────────────────────────

/**
 * Update nanopayment row status after agent processes the call.
 * Called by each capability endpoint after completing its work.
 *
 * When payments disabled: status = "skipped"
 * When payments enabled but no real ref: status = "completed"
 * When real payment ref exists: status = "paid"
 */
export async function recordAgentCapabilityResult(
  context: AgentContextPayload,
  result: { ok: boolean; outputHash?: string; error?: string }
): Promise<void> {
  const flags = getPaymentFlags();

  let status: string;
  if (!flags.agentNanopaymentsEnabled) {
    status = "skipped";
  } else if (result.ok) {
    status = "completed";
  } else {
    status = "failed";
  }

  // Find nanopayment row by receipt_id and update
  try {
    await updateNanopaymentStatus(
      context.receipt_id, // used as receipt_id lookup
      status,
      {
        paymentRef: undefined, // real ref only from Gateway/Circle
        settlementRef: undefined,
      }
    );
  } catch {
    // Non-fatal — audit trail already exists from creation
    console.error(
      `[agent-capability] Failed to update nanopayment status for receipt ${context.receipt_id}`
    );
  }
}
