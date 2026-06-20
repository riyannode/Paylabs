/**
 * Circle Gateway x402 Settlement Service
 *
 * Uses @circle-fin/x402-batching BatchFacilitatorClient for settlement.
 * Replaces hand-rolled EIP-712 + manual Gateway fetch with Circle's official SDK.
 *
 * Refactored to match circlefin/arc-nanopayments reference implementation.
 */

// ─── Constants ───────────────────────────────────────────────

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

// ─── SDK Client (lazy async init) ────────────────────────────

let _facilitator: any = null;

async function getFacilitator() {
  if (_facilitator) return _facilitator;

  // Dynamic import — works in ESM and CJS
  const mod = await import("@circle-fin/x402-batching/server");
  const BatchFacilitatorClient = mod.BatchFacilitatorClient;
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

  return { configured: missing.length === 0, missing };
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

/**
 * Verify and settle an x402 payment using Circle's official SDK.
 *
 * Matches circlefin/arc-nanopayments pattern:
 *   facilitator.verify(payload, requirements)
 *   facilitator.settle(payload, requirements)
 */
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
        gatewayResponse: verifyResult as Record<string, unknown>,
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
        gatewayResponse: settleResult as Record<string, unknown>,
      };
    }

    // Extract real refs from settlement response
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
      gatewayResponse: settleResult as Record<string, unknown>,
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

/**
 * Build x402 payment requirements for a given receiver and amount.
 * Matches circlefin/arc-nanopayments pattern.
 */
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
