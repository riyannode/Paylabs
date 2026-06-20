/**
 * Circle Gateway x402 Settlement Service
 *
 * Uses @circle-fin/x402-batching BatchFacilitatorClient for settlement.
 * Matches circlefin/arc-nanopayments reference implementation.
 */

// ─── Constants ───────────────────────────────────────────────

import { createRequire } from "node:module";

const ARC_CHAIN_ID = 5042002;
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_BASE_URL_TESTNET = "https://gateway-api-testnet.circle.com/v1";

// ─── Types ───────────────────────────────────────────────────

export interface X402SettleInput {
  paymentPayload: Record<string, unknown>;
  paymentRequirements: Record<string, unknown>;
}

export interface X402SettleResult {
  ok: boolean;
  paymentRef?: string;
  settlementRef?: string;
  /** Sanitized gateway response — no raw signatures or authorization payloads */
  gatewaySummary?: Record<string, unknown>;
  error?: string;
  infraFailure?: boolean;
}

export interface GatewayBalanceCheck {
  ok: boolean;
  balance?: string;
  pendingBatch?: string;
  error?: string;
}

// ─── SDK Client (lazy async init) ────────────────────────────

let _facilitator: any = null;

function getFacilitator() {
  if (_facilitator) return _facilitator;

  // CJS interop — same pattern as circleDcw.ts
  const _require = createRequire(import.meta.url);
  const { BatchFacilitatorClient } = _require("@circle-fin/x402-batching/server");
  _facilitator = new BatchFacilitatorClient();
  return _facilitator;
}

// ─── Config Check ────────────────────────────────────────────

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

// ─── Sanitize gateway response ──────────────────────────────
// Strip raw signatures, authorization payloads, and signed data.
// Only keep settlement metadata for audit trail.

function sanitizeGatewayResponse(raw: Record<string, unknown>): Record<string, unknown> {
  const { payload, authorization, signature, paymentPayload, ...safe } = raw as Record<string, unknown>;
  return {
    success: safe.success,
    errorReason: safe.errorReason,
    transaction: safe.transaction,
    settlementId: safe.settlementId,
    network: safe.network,
  };
}

// ─── Extract nonce hash from x402 payload ───────────────────
// For internal duplicate guard. Hash of (from + nonce) to detect replays
// even if Gateway also rejects them.

export function extractNonceHash(paymentPayload: Record<string, unknown>): string | null {
  try {
    const payload = paymentPayload.payload as Record<string, unknown> | undefined;
    if (!payload) return null;
    const auth = payload.authorization as Record<string, unknown> | undefined;
    if (!auth) return null;
    const from = String(auth.from || "").toLowerCase();
    const nonce = String(auth.nonce || "");
    if (!from || !nonce) return null;
    // Simple hash — not cryptographic, just for DB dedup
    return `${from}:${nonce}`;
  } catch {
    return null;
  }
}

// ─── Gateway Balance (direct API — no SDK equivalent) ────────

export async function queryGatewayBalance(
  depositorAddress: string
): Promise<GatewayBalanceCheck> {
  try {
    const res = await fetch(`${GATEWAY_BASE_URL_TESTNET}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: 26, depositor: depositorAddress.toLowerCase() }],
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

// ─── x402 Settlement via BatchFacilitatorClient ─────────────

export async function settleX402Payment(
  input: X402SettleInput
): Promise<X402SettleResult> {
  try {
    const facilitator = await getFacilitator();

    // Step 1: Verify
    const verifyResult = await facilitator.verify(
      input.paymentPayload,
      input.paymentRequirements
    );

    if (!verifyResult?.isValid) {
      return {
        ok: false,
        error: `x402 verify failed: ${verifyResult?.invalidReason || "unknown"}`,
        gatewaySummary: sanitizeGatewayResponse(verifyResult as Record<string, unknown>),
      };
    }

    // Step 2: Settle
    const settleResult = await facilitator.settle(
      input.paymentPayload,
      input.paymentRequirements
    );

    if (!settleResult?.success) {
      const isInfra =
        settleResult?.errorReason === "insufficient_balance" ||
        settleResult?.errorReason === "internal_error";
      return {
        ok: false,
        error: `x402 settle rejected: ${settleResult?.errorReason || "unknown"}`,
        infraFailure: isInfra,
        gatewaySummary: sanitizeGatewayResponse(settleResult as Record<string, unknown>),
      };
    }

    const paymentRef = (settleResult.paymentRef ||
      settleResult.paymentId ||
      settleResult.settlementId ||
      settleResult.transaction) as string | undefined;
    const settlementRef = (settleResult.settlementRef ||
      settleResult.settlementId ||
      settleResult.transaction) as string | undefined;

    return {
      ok: true,
      paymentRef,
      settlementRef,
      gatewaySummary: sanitizeGatewayResponse(settleResult as Record<string, unknown>),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes("timeout") || msg.includes("Timeout");
    return {
      ok: false,
      error: `x402 settlement failed: ${msg}`,
      infraFailure: isTimeout,
    };
  }
}

// ─── Build x402 challenge (payment requirements) ────────────

export function buildPaymentRequirements(
  receiverAddress: string,
  amountBaseUnits: string
) {
  return {
    scheme: "exact",
    network: `eip155:${ARC_CHAIN_ID}`,
    asset: USDC_ARC_TESTNET,
    amount: amountBaseUnits,
    payTo: receiverAddress,
    maxTimeoutSeconds: 604900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: GATEWAY_WALLET_TESTNET,
    },
  };
}

/**
 * Build full x402 challenge payload for PAYMENT-REQUIRED header.
 * Returns base64-encoded JSON per x402 v2 protocol.
 */
export function buildX402Challenge(
  receiverAddress: string,
  amountBaseUnits: string,
  resourceUrl: string
): string {
  const requirements = buildPaymentRequirements(receiverAddress, amountBaseUnits);
  const challenge = {
    x402Version: 2,
    accepts: [requirements],
    resource: {
      url: resourceUrl,
      description: "PayLabs payment",
      mimeType: "application/json",
    },
  };
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
}

// ─── Gateway Reachable Check ─────────────────────────────────

export async function checkGatewayReachable(): Promise<{
  reachable: boolean;
  error?: string;
  supportedDomains?: number[];
}> {
  try {
    const res = await fetch(`https://gateway-api-testnet.circle.com/v1/info`, {
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
