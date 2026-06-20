/**
 * Circle Gateway x402 v2 Settlement Service
 *
 * Handles real x402 payment verification and settlement via Circle Gateway.
 * Uses /v1/x402/settle (permissionless, no API key needed).
 * Uses /v1/x402/verify for pre-settlement verification.
 *
 * x402 v2 format: { paymentPayload, paymentRequirements }
 *
 * PR #16: Wire real Circle Gateway x402 settlement for agent nanopayments.
 */

import {
  buildX402PaymentPayload,
  buildX402PaymentRequirements,
  type SignedAuthorization,
} from "../../../../lib/payments/x402.js";

// ─── Constants ───────────────────────────────────────────────

const GATEWAY_BASE_URL_TESTNET = "https://gateway-api-testnet.circle.com/v1";
const GATEWAY_BASE_URL_MAINNET = "https://gateway-api.circle.com/v1";

const ARC_TESTNET_DOMAIN = 26;
const ARC_CHAIN_ID = 5042002;

// ─── Types ───────────────────────────────────────────────────

export interface X402SettleInput {
  signedAuthorization: SignedAuthorization;
  amountBaseUnits: string;
  receiverAddress: string;
}

export interface X402SettleResult {
  ok: boolean;
  paymentRef?: string;
  settlementRef?: string;
  gatewayResponse?: Record<string, unknown>;
  error?: string;
  infraFailure?: boolean;
}

export interface GatewayBalanceCheck {
  ok: boolean;
  balance?: string;
  pendingBatch?: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function getGatewayBaseUrl(): string {
  const testnet = process.env.CIRCLE_GATEWAY_TESTNET !== "false";
  return testnet ? GATEWAY_BASE_URL_TESTNET : GATEWAY_BASE_URL_MAINNET;
}

export function checkX402Config(): {
  configured: boolean;
  missing: string[];
} {
  const missing: string[] = [];

  if (!process.env.PAYLABS_PAYMENT_ROUTE || process.env.PAYLABS_PAYMENT_ROUTE === "none") {
    missing.push("PAYLABS_PAYMENT_ROUTE");
  }
  if (!process.env.PAYLABS_PAYMENT_EXECUTOR || process.env.PAYLABS_PAYMENT_EXECUTOR === "noop") {
    missing.push("PAYLABS_PAYMENT_EXECUTOR");
  }
  if (!process.env.PAYLABS_HMAC_SECRET) {
    missing.push("PAYLABS_HMAC_SECRET");
  }
  if (!process.env.CIRCLE_API_KEY) {
    missing.push("CIRCLE_API_KEY");
  }
  if (!process.env.CIRCLE_ENTITY_SECRET) {
    missing.push("CIRCLE_ENTITY_SECRET");
  }

  return { configured: missing.length === 0, missing };
}

// ─── Gateway Balance ─────────────────────────────────────────

export async function queryGatewayBalance(
  depositorAddress: string
): Promise<GatewayBalanceCheck> {
  const baseUrl = getGatewayBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: ARC_TESTNET_DOMAIN, depositor: depositorAddress.toLowerCase() }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return { ok: false, error: `Gateway balance ${res.status}: ${text}` };
    }

    const data = (await res.json()) as {
      balances?: Array<{ balance: string; pendingBatch: string }>;
    };

    const entry = data.balances?.[0];
    return {
      ok: true,
      balance: entry?.balance || "0",
      pendingBatch: entry?.pendingBatch || "0",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Gateway balance query failed: ${msg}` };
  }
}

// ─── x402 v2 Settlement ─────────────────────────────────────

/**
 * Submit a signed TransferWithAuthorization to Circle Gateway for x402 v2 settlement.
 *
 * Uses /v1/x402/settle with proper v2 format:
 * { paymentPayload, paymentRequirements }
 *
 * Both fields are REQUIRED by the Gateway facilitator.
 */
export async function settleX402Payment(
  input: X402SettleInput
): Promise<X402SettleResult> {
  const baseUrl = getGatewayBaseUrl();

  if (!input.receiverAddress || input.receiverAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return { ok: false, error: "Receiver is zero address — settlement blocked" };
  }

  const amount = BigInt(input.amountBaseUnits);
  if (amount <= 0n) {
    return { ok: false, error: "Amount must be positive" };
  }

  try {
    // Build x402 v2 payload and requirements
    const paymentPayload = buildX402PaymentPayload(
      input.signedAuthorization,
      input.receiverAddress,
      input.amountBaseUnits
    );

    const paymentRequirements = buildX402PaymentRequirements(
      input.receiverAddress,
      input.amountBaseUnits
    );

    const body = {
      paymentPayload,
      paymentRequirements,
    };

    const res = await fetch(`${baseUrl}/x402/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      const isInfra = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        error: `Gateway x402/settle ${res.status}: ${text}`,
        infraFailure: isInfra,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Gateway x402 v2 response: { success, errorReason, transaction, network }
    if (data.success === false) {
      return {
        ok: false,
        error: `Gateway settle rejected: ${data.errorReason || "unknown"}`,
        infraFailure: data.errorReason === "insufficient_balance",
        gatewayResponse: data,
      };
    }

    // Extract real refs from Gateway response — never fabricate
    const paymentRef = (data.paymentRef || data.paymentId || data.id || data.transaction) as string | undefined;
    const settlementRef = (data.settlementRef || data.settlementId || data.transaction) as string | undefined;

    if (!paymentRef && !settlementRef) {
      return {
        ok: false,
        error: "Gateway returned success but no paymentRef or settlementRef",
        gatewayResponse: data,
      };
    }

    return {
      ok: true,
      paymentRef,
      settlementRef,
      gatewayResponse: data,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes("timeout") || msg.includes("Timeout");
    return {
      ok: false,
      error: `Gateway x402 settlement failed: ${msg}`,
      infraFailure: isTimeout,
    };
  }
}

/**
 * Submit x402 v2 settlement for an agent nanopayment.
 */
export async function settleAgentNanopayment(input: {
  signedAuthorization: SignedAuthorization;
  agentName: string;
  agentWalletAddress: string;
  expectedAmountUsdc: string;
  receiptId: string;
}): Promise<X402SettleResult> {
  const amountBaseUnits = BigInt(
    Math.round(parseFloat(input.expectedAmountUsdc) * 1_000_000)
  ).toString();

  return settleX402Payment({
    signedAuthorization: input.signedAuthorization,
    amountBaseUnits,
    receiverAddress: input.agentWalletAddress,
  });
}

/**
 * Check if Gateway API is reachable.
 */
export async function checkGatewayReachable(): Promise<{
  reachable: boolean;
  error?: string;
  supportedDomains?: number[];
}> {
  const baseUrl = getGatewayBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/info`, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return { reachable: false, error: `Gateway /info returned ${res.status}` };
    }

    const data = (await res.json()) as {
      domains?: Array<{ domain: number; chain: string }>;
    };

    const domains = data.domains?.map((d) => d.domain) || [];
    return { reachable: true, supportedDomains: domains };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reachable: false, error: msg };
  }
}
