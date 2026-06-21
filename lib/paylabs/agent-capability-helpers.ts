/**
 * Agent Capability Endpoint Validation
 *
 * Shared validation logic for all 7 paid agent capability endpoints.
 * Enforces 3 request headers and 3 response headers.
 *
 * TWO MODES (controlled by PAYLABS_AGENT_NANOPAYMENTS_ENABLED):
 *
 * Mode 1: Audit-only (flag = false, default)
 *   - Validates HMAC-signed context
 *   - Returns DB status
 *   - Does NOT execute agent (execution via unified pipeline)
 *
 * Mode 2: Real x402 (flag = true)
 *   - If no payment header: returns 402 + PAYMENT-REQUIRED challenge
 *   - If payment header present: verifies/settles via Circle x402
 *   - Then executes the real agent logic
 *   - Returns agent output + safe payment metadata
 *
 * Request headers:
 *   x-payment              — Gateway/x402 payment payload (base64 JSON)
 *   x-paylabs-agent-context — Signed compact JSON with agent context
 *   x-paylabs-receipt-link  — PayLabs receipt URL
 *
 * Response headers:
 *   x-payment-response     — Payment acknowledgement
 *   x-paylabs-agent-context — Echo back signed context
 *   x-paylabs-receipt-link  — Receipt URL
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAgentContext, type AgentContextPayload } from "@/lib/paylabs/x402/agent-context";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import { AGENT_NANOPRICE_USDC, resolveAgentWallet, type PaidAgentName } from "@/lib/paylabs/agent-registry";
import {
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
  type X402ChallengeRequirements,
} from "@/lib/paylabs/x402/seller-challenge";

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
 * 7. x-payment present when payments enabled
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

// ─── x402 Challenge Response ───────────────────────────────────

/**
 * Build a 402 response with proper PAYMENT-REQUIRED header.
 * The buyer decodes this header to get payment requirements,
 * signs via BatchEvmScheme + DCW signTypedData, then retries.
 *
 * The challenge includes:
 *   - x402Version: 2
 *   - scheme: exact
 *   - network: eip155:5042002 (Arc Testnet)
 *   - asset: USDC address
 *   - amount: agent nanoprice in atomic units
 *   - payTo: seller (agent) wallet address
 *   - extra: GatewayWalletBatched verifying contract
 */
export function build402ChallengeResponse(
  agentName: PaidAgentName
): NextResponse {
  const sellerAddress = resolveAgentWallet(agentName);
  if (!sellerAddress) {
    return NextResponse.json(
      { error: `Seller wallet not configured for ${agentName}` },
      { status: 500 }
    );
  }

  // Convert USDC human-readable to atomic (6 decimals)
  const amountAtomic = Math.round(
    parseFloat(AGENT_NANOPRICE_USDC) * 1_000_000
  ).toString();

  const challenge = buildX402Challenge(sellerAddress, amountAtomic);
  const encoded = encodeChallengeHeader(challenge);

  const response = NextResponse.json(
    {
      error: "Payment required",
      x402: true,
      amount_usdc: AGENT_NANOPRICE_USDC,
      agent_name: agentName,
    },
    { status: 402 }
  );

  // Set the PAYMENT-REQUIRED header (base64 encoded JSON)
  response.headers.set("PAYMENT-REQUIRED", encoded);

  return response;
}

// ─── x402 Payment Verification ─────────────────────────────────

/**
 * Verify and settle an x402 payment from the PAYMENT-SIGNATURE header.
 * Returns the settlement result — ok + safe metadata, or error.
 */
export async function verifyPaymentHeader(
  paymentSignatureBase64: string,
  agentName: PaidAgentName
): Promise<{
  ok: boolean;
  payer?: string;
  safePayment?: {
    amountAtomic: string;
    payTo: string;
    network: string;
  };
  error?: string;
}> {
  const sellerAddress = resolveAgentWallet(agentName);
  if (!sellerAddress) {
    return { ok: false, error: `Seller wallet not configured for ${agentName}` };
  }

  const amountAtomic = Math.round(
    parseFloat(AGENT_NANOPRICE_USDC) * 1_000_000
  ).toString();

  const requirements: X402ChallengeRequirements = {
    scheme: "exact",
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: amountAtomic,
    payTo: sellerAddress.toLowerCase(),
    maxTimeoutSeconds: 604900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };

  const result = await verifyAndSettlePayment(paymentSignatureBase64, requirements);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    payer: result.payer,
    safePayment: result.paymentMeta
      ? {
          amountAtomic: result.paymentMeta.amountAtomic,
          payTo: result.paymentMeta.payTo,
          network: result.paymentMeta.network,
        }
      : undefined,
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
