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
 * Look up nanopayment row status by receipt_id.
 * Returns the actual DB status — never a fake hardcoded value.
 * The real agent execution happens via the unified LangGraph pipeline
 * (POST /api/paylabs/discovery-runs/pay), not through these endpoints.
 */
export async function getAgentCapabilityStatus(
  context: AgentContextPayload
): Promise<{ status: string; receipt_id: string; agent_name: string }> {
  const { getNanopaymentByReceipt } = await import("@/lib/paylabs/nanopayment-service");
  const row = await getNanopaymentByReceipt(context.receipt_id);

  return {
    status: row?.status || "not_found",
    receipt_id: context.receipt_id,
    agent_name: context.agent_name,
  };
}
