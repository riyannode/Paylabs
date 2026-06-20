/**
 * Circle Gateway x402 Settlement Service
 *
 * Handles real x402 payment verification and settlement via Circle Gateway.
 * Uses /v1/x402/settle (permissionless, no API key needed).
 *
 * PR #16: Wire real Circle Gateway x402 settlement for agent nanopayments.
 */

// ─── Constants ───────────────────────────────────────────────

const GATEWAY_BASE_URL_TESTNET = "https://gateway-api-testnet.circle.com/v1";
const GATEWAY_BASE_URL_MAINNET = "https://gateway-api.circle.com/v1";

const ARC_TESTNET_DOMAIN = 26;
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const ARC_CHAIN_ID = 5042002;

// ─── Types ───────────────────────────────────────────────────

export interface X402SettleInput {
  /** Signed TransferWithAuthorization from user wallet */
  signedAuthorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    signature: string;
  };
  /** Amount in USDC base units (6 decimals) */
  amountBaseUnits: string;
  /** Receiver wallet address (treasury or agent) */
  receiverAddress: string;
}

export interface X402SettleResult {
  ok: boolean;
  paymentRef?: string;
  settlementRef?: string;
  gatewayResponse?: Record<string, unknown>;
  error?: string;
  /** True if Gateway rejected due to config/infra issue, not user error */
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

/**
 * Check if Gateway/x402 route is properly configured.
 * Returns list of missing config items.
 */
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

/**
 * Query Gateway unified balance for a depositor on Arc Testnet.
 * Gateway REST /v1/balances is permissionless — no API key needed.
 */
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

// ─── x402 Settlement ─────────────────────────────────────────

/**
 * Submit a signed TransferWithAuthorization to Circle Gateway for x402 settlement.
 *
 * Uses /v1/x402/settle — the permissionless x402 settlement endpoint.
 * NOT /transfers (which is for crosschain burn/mint).
 *
 * Returns real payment_ref / settlement_ref from Gateway response.
 * Fails closed on error — never returns fake refs.
 */
export async function settleX402Payment(
  input: X402SettleInput
): Promise<X402SettleResult> {
  const baseUrl = getGatewayBaseUrl();

  // Validate receiver is not zero address
  if (!input.receiverAddress || input.receiverAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return { ok: false, error: "Receiver is zero address — settlement blocked" };
  }

  // Validate amount
  const amount = BigInt(input.amountBaseUnits);
  if (amount <= 0n) {
    return { ok: false, error: "Amount must be positive" };
  }

  try {
    const body = {
      chainId: ARC_CHAIN_ID,
      tokenAddress: USDC_ARC_TESTNET,
      amount: input.amountBaseUnits,
      from: input.signedAuthorization.from,
      to: input.receiverAddress,
      transferWithAuthorization: {
        value: input.signedAuthorization.value,
        validAfter: input.signedAuthorization.validAfter,
        validBefore: input.signedAuthorization.validBefore,
        nonce: input.signedAuthorization.nonce,
        signature: input.signedAuthorization.signature,
      },
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

    // Extract real refs from Gateway response — never fabricate
    const paymentRef = (data.paymentRef || data.paymentId || data.id) as string | undefined;
    const settlementRef = (data.settlementRef || data.settlementId) as string | undefined;

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
 * Submit x402 settlement for an agent nanopayment.
 * Convenience wrapper with agent-specific validation.
 */
export async function settleAgentNanopayment(input: {
  signedAuthorization: X402SettleInput["signedAuthorization"];
  agentName: string;
  agentWalletAddress: string;
  expectedAmountUsdc: string; // "0.000001"
  receiptId: string;
}): Promise<X402SettleResult> {
  // Convert human-readable to base units
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
 * Returns { reachable: boolean; error?: string; domains?: number[] }
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
    const arcSupported = domains.includes(ARC_TESTNET_DOMAIN);

    return {
      reachable: true,
      supportedDomains: domains,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reachable: false, error: msg };
  }
}
