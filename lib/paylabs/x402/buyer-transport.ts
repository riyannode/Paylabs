/**
 * x402 Buyer Transport via Circle DCW Wallets
 *
 * Handles the full buyer-side x402 payment flow:
 *   1. Call seller endpoint (no payment) → get 402 challenge
 *   2. Decode PAYMENT-REQUIRED header → extract paymentRequirements
 *   3. Create payment payload via BatchEvmScheme + DCW signTypedData
 *   4. Retry seller endpoint with PAYMENT-SIGNATURE header
 *   5. Return seller response + safe payment metadata
 *
 * This transport uses Circle DCW wallets as the buyer identity.
 * DCW holds the private key — we never see it. We call signTypedData()
 * via Circle API and get back a signature.
 *
 * Prerequisites:
 *   - Buyer DCW wallet must have USDC deposited into Circle Gateway
 *   - Seller endpoint must return 402 with PAYMENT-REQUIRED header
 *   - Seller endpoint must accept PAYMENT-SIGNATURE header on retry
 *
 * Dependency direction: lib/ → imports nothing from apps/.
 * DCW signing is injected via DcwSigner interface.
 */

import { createRequire } from "node:module";
import type { Address, Hex } from "viem";

// CJS interop — @circle-fin/x402-batching has CJS entry
const _require = createRequire(import.meta.url);

// ─── Lazy SDK imports ───────────────────────────────────────

let _BatchEvmScheme: any = null;

function getBatchEvmSchemeClass() {
  if (_BatchEvmScheme) return _BatchEvmScheme;
  const mod = _require("@circle-fin/x402-batching/client");
  _BatchEvmScheme = mod.BatchEvmScheme;
  if (!_BatchEvmScheme) {
    throw new X402BuyerError("BatchEvmScheme not found in @circle-fin/x402-batching/client");
  }
  return _BatchEvmScheme;
}

// ─── Types ───────────────────────────────────────────────────

/**
 * DCW signing interface — injected by caller.
 * Decouples lib/ from apps/vercel-backend/.
 */
export interface DcwSigner {
  /** Sign EIP-712 typed data via DCW wallet. Returns 0x hex signature. */
  signTypedData(input: {
    walletId: string;
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;

  /** Get wallet address from DCW wallet ID. Throws if not found. */
  getWalletAddress(walletId: string): Promise<string>;
}

export interface X402BuyerCallInput {
  /** Seller endpoint URL */
  sellerUrl: string;
  /** HTTP method */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Request body (for POST/PUT) */
  body?: unknown;
  /** Additional request headers */
  headers?: Record<string, string>;
  /** DCW wallet ID of the buyer agent */
  buyerWalletId: string;
  /** Buyer agent name (for audit) */
  buyerAgentName: string;
  /** Seller service name (for audit) */
  sellerServiceName: string;
  /** Discovery run ID (for audit) */
  discoveryRunId?: string;
  /** Max amount the buyer is willing to pay (USDC decimal string) */
  maxAmountUsdc: string;
}

export interface X402BuyerCallResult {
  ok: boolean;
  /** HTTP status from seller after payment */
  status?: number;
  /** Seller response body (parsed JSON or text) */
  data?: unknown;
  /** Payment metadata for audit (no raw signatures) */
  paymentMetadata?: {
    amountAtomic: string;
    payTo: string;
    network: string;
    x402Version: number;
  };
  /** Error message if failed */
  error?: string;
  /** Whether this was a payment-free response (no 402) */
  freeResponse?: boolean;
  /** HTTP status from initial 402 challenge */
  challengeStatus?: number;
}

// ─── Core Buyer Transport ────────────────────────────────────

/**
 * Execute a paid seller call via x402 protocol using DCW wallet.
 *
 * Flow:
 *   1. POST to seller without payment → expect 402 + PAYMENT-REQUIRED
 *   2. Decode challenge → extract paymentRequirements
 *   3. Validate amount ≤ maxAmountUsdc
 *   4. Create BatchEvmScheme(signer) → createPaymentPayload()
 *   5. Base64 encode → retry with PAYMENT-SIGNATURE header
 *   6. Return seller response
 *
 * If seller returns non-402 on first call, treats as free response.
 * If amount exceeds max, throws without signing.
 * If signing fails, throws (fail closed).
 */
export async function callPaidSeller(
  dcwSigner: DcwSigner,
  input: X402BuyerCallInput
): Promise<X402BuyerCallResult> {
  const {
    sellerUrl,
    method = "POST",
    body,
    headers = {},
    buyerWalletId,
    sellerServiceName,
    maxAmountUsdc,
  } = input;

  // ── Step 1: Initial request (no payment) ─────────────────

  const initialHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  let initialResp: Response;
  try {
    initialResp = await fetch(sellerUrl, {
      method,
      headers: initialHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Seller endpoint unreachable: ${msg}` };
  }

  // If not 402, treat as free response (seller doesn't require payment)
  if (initialResp.status !== 402) {
    let data: unknown;
    try {
      data = await initialResp.json();
    } catch {
      data = await initialResp.text().catch(() => null);
    }
    return {
      ok: initialResp.ok,
      status: initialResp.status,
      data,
      freeResponse: true,
    };
  }

  // ── Step 2: Decode 402 challenge ─────────────────────────

  const paymentRequiredHeader =
    initialResp.headers.get("payment-required") ??
    initialResp.headers.get("PAYMENT-REQUIRED");

  if (!paymentRequiredHeader) {
    return {
      ok: false,
      error: "Seller returned 402 but no PAYMENT-REQUIRED header",
      challengeStatus: 402,
    };
  }

  let challenge: X402Challenge;
  try {
    const decoded = Buffer.from(paymentRequiredHeader, "base64").toString("utf-8");
    challenge = JSON.parse(decoded);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Invalid PAYMENT-REQUIRED header (not valid base64 JSON): ${msg}`,
      challengeStatus: 402,
    };
  }

  // Find the GatewayWalletBatched payment option
  const accepts = challenge.accepts || [];
  const gatewayReq = accepts.find(
    (r) =>
      r?.extra?.name === "GatewayWalletBatched" ||
      (r?.scheme === "exact" && r?.extra?.verifyingContract)
  );

  if (!gatewayReq) {
    return {
      ok: false,
      error: "No Circle Gateway batching option in 402 challenge",
      challengeStatus: 402,
    };
  }

  // ── Step 3: Validate amount ──────────────────────────────

  const reqAmountAtomic = BigInt(gatewayReq.amount || "0");
  const maxAmountAtomic = BigInt(Math.round(parseFloat(maxAmountUsdc) * 1_000_000));

  if (reqAmountAtomic > maxAmountAtomic) {
    return {
      ok: false,
      error: `Required amount (${gatewayReq.amount} atomic) exceeds max (${maxAmountUsdc} USDC = ${maxAmountAtomic} atomic)`,
      challengeStatus: 402,
    };
  }

  // ── Step 4: Get buyer wallet address ─────────────────────

  let buyerAddress: string;
  try {
    buyerAddress = await dcwSigner.getWalletAddress(buyerWalletId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to resolve buyer wallet: ${msg}` };
  }

  if (!buyerAddress.startsWith("0x") || buyerAddress.length !== 42) {
    return { ok: false, error: `Buyer wallet has invalid address: ${buyerAddress}` };
  }

  // ── Step 5: Create payment payload via BatchEvmScheme ────

  const signer: BatchEvmSignerLike = {
    address: buyerAddress.toLowerCase() as Address,
    signTypedData: async (params) => {
      const signature = await dcwSigner.signTypedData({
        walletId: buyerWalletId,
        domain: {
          name: params.domain.name,
          version: params.domain.version,
          chainId: params.domain.chainId,
          verifyingContract: params.domain.verifyingContract,
        },
        types: params.types,
        primaryType: params.primaryType,
        message: params.message as Record<string, unknown>,
      });
      return signature as Hex;
    },
  };

  const BatchEvmScheme = getBatchEvmSchemeClass();
  const scheme = new BatchEvmScheme(signer);

  let paymentPayload: { x402Version: number; payload: unknown };
  try {
    paymentPayload = await scheme.createPaymentPayload(
      challenge.x402Version || 2,
      {
        scheme: gatewayReq.scheme,
        network: gatewayReq.network,
        asset: gatewayReq.asset,
        amount: gatewayReq.amount,
        payTo: gatewayReq.payTo,
        maxTimeoutSeconds: gatewayReq.maxTimeoutSeconds || 604900,
        extra: gatewayReq.extra,
      }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Payment payload creation failed: ${msg}`,
      challengeStatus: 402,
    };
  }

  // ── Step 6: Encode payment signature (base64) ────────────

  const paymentSignatureValue = Buffer.from(
    JSON.stringify(paymentPayload)
  ).toString("base64");

  // ── Step 7: Retry with payment ───────────────────────────

  let retryResp: Response;
  try {
    retryResp = await fetch(sellerUrl, {
      method,
      headers: {
        ...initialHeaders,
        "PAYMENT-SIGNATURE": paymentSignatureValue,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Seller endpoint unreachable after payment: ${msg}`,
      paymentMetadata: extractPaymentMetadata(gatewayReq, paymentPayload),
    };
  }

  // Handle 409 as idempotent success (already paid)
  if (retryResp.status === 409) {
    const text = await retryResp.text().catch(() => "");
    if (text.includes("already") || text.includes("active access session")) {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return {
        ok: true,
        status: 409,
        data,
        paymentMetadata: extractPaymentMetadata(gatewayReq, paymentPayload),
      };
    }
  }

  let retryData: unknown;
  try {
    retryData = await retryResp.json();
  } catch {
    retryData = await retryResp.text().catch(() => null);
  }

  return {
    ok: retryResp.ok,
    status: retryResp.status,
    data: retryData,
    paymentMetadata: extractPaymentMetadata(gatewayReq, paymentPayload),
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract safe payment metadata for audit trail.
 * Never stores raw signatures or authorization payloads.
 */
function extractPaymentMetadata(
  requirements: PaymentRequirementsLike,
  payload: { x402Version: number; payload: unknown }
): X402BuyerCallResult["paymentMetadata"] {
  return {
    amountAtomic: requirements.amount,
    payTo: requirements.payTo,
    network: requirements.network,
    x402Version: payload.x402Version,
  };
}

// ─── Internal Types ──────────────────────────────────────────

interface X402Challenge {
  x402Version: number;
  accepts: PaymentRequirementsLike[];
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
}

interface PaymentRequirementsLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/**
 * Minimal signer interface matching BatchEvmSigner from @circle-fin/x402-batching.
 * Defined locally to avoid importing the full SDK type at the module level.
 */
interface BatchEvmSignerLike {
  address: Address;
  signTypedData: (params: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

// ─── Error class ─────────────────────────────────────────────

export class X402BuyerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402BuyerError";
  }
}
