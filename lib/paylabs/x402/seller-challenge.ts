/**
 * Seller-Side x402 Gateway Challenge Middleware
 *
 * Returns HTTP 402 with proper PAYMENT-REQUIRED header containing
 * Circle Gateway x402 payment requirements. The buyer uses this
 * challenge to create a signed payment payload via BatchEvmScheme.
 *
 * Also provides verify+settle for the retry request with payment header.
 *
 * Flow:
 *   1. Buyer calls seller endpoint (no payment)
 *   2. Seller returns 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   3. Buyer signs payment payload, retries with PAYMENT-SIGNATURE header
 *   4. Seller verifies signature via BatchFacilitatorClient
 *   5. Seller settles payment via BatchFacilitatorClient
 *   6. Seller executes agent logic and returns result
 */

import { createRequire } from "node:module";

// CJS interop — @circle-fin/x402-batching has CJS entry
const _require = createRequire(import.meta.url);

// ─── Lazy SDK imports ───────────────────────────────────────

let _BatchFacilitatorClient: any = null;

function getBatchFacilitatorClient() {
  if (_BatchFacilitatorClient) return _BatchFacilitatorClient;
  try {
    const mod = _require("@circle-fin/x402-batching/server");
    _BatchFacilitatorClient = mod.BatchFacilitatorClient;
  } catch {
    // SDK not installed — will fail closed
  }
  return _BatchFacilitatorClient;
}

// ─── Types ────────────────────────────────────────────────────

export interface X402ChallengeRequirements {
  scheme: string;
  network: string;
  asset: string;
  /** Amount in atomic units (6 decimals for USDC) */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    verifyingContract: string;
  };
}

export interface X402ChallengeResponse {
  x402Version: number;
  accepts: X402ChallengeRequirements[];
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
}

export interface VerifyAndSettleResult {
  ok: boolean;
  /** Whether the payment was verified and settled */
  settled: boolean;
  /** Safe payment metadata (no raw signatures) */
  paymentMeta?: {
    amountAtomic: string;
    payTo: string;
    network: string;
    x402Version: number;
    /** Transaction hash if available from facilitator settle */
    txHash: string | null;
    /** Block explorer URL if txHash is valid */
    explorerUrl: string | null;
  };
  /** Payer address if verified */
  payer?: string;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────

/** Gateway Wallet on Arc Testnet */
const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/** USDC on Arc Testnet */
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

/** Arc Testnet network identifier for x402 */
const ARC_NETWORK = "eip155:5042002";

/** x402 protocol version */
export const X402_VERSION = 2;

/**
 * Default timeout for payment authorization.
 * MUST match GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS from @circle-fin/x402-batching
 * to avoid implicit Math.max bump during verify/settle.
 * SDK value = GATEWAY_MIN_AUTH_VALIDITY_SECONDS (7 days) + buffer (100s) = 604900.
 * Client MUST use BatchEvmScheme.createPaymentPayload() — NOT raw EIP-712 signing.
 */
const DEFAULT_MAX_TIMEOUT = 604900;

// ─── Build 402 Challenge ──────────────────────────────────────

/**
 * Build the x402 payment requirements for a given seller and amount.
 * Used to construct the PAYMENT-REQUIRED header for HTTP 402 responses.
 */
export function buildPaymentRequirements(
  sellerAddress: string,
  amountAtomic: string
): X402ChallengeRequirements {
  return {
    scheme: "exact",
    network: ARC_NETWORK,
    asset: USDC_ADDRESS,
    amount: amountAtomic,
    payTo: sellerAddress.toLowerCase(),
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: GATEWAY_WALLET_ADDRESS,
    },
  };
}

/**
 * Build the full x402 challenge response body.
 * The seller encodes this as base64 JSON in the PAYMENT-REQUIRED header.
 */
export function buildX402Challenge(
  sellerAddress: string,
  amountAtomic: string,
  resourceUrl?: string
): X402ChallengeResponse {
  const requirements = buildPaymentRequirements(sellerAddress, amountAtomic);

  return {
    x402Version: X402_VERSION,
    accepts: [requirements],
    ...(resourceUrl
      ? {
          resource: {
            url: resourceUrl,
            description: "PayLabs agent capability service",
            mimeType: "application/json",
          },
        }
      : {}),
  };
}

/**
 * Encode challenge as base64 JSON for the PAYMENT-REQUIRED header.
 */
export function encodeChallengeHeader(challenge: X402ChallengeResponse): string {
  return Buffer.from(JSON.stringify(challenge)).toString("base64");
}

// ─── TxHash Extraction Helpers ────────────────────────────────

function isEvmTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

function extractTxHash(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const transaction = obj.transaction;
  const receipt = obj.receipt as Record<string, unknown> | undefined;
  const settlement = obj.settlement as Record<string, unknown> | undefined;

  const candidates = [
    obj.txHash,
    obj.transactionHash,
    obj.hash,
    // transaction may be a string (txHash) or an object with .hash
    typeof transaction === "string" ? transaction : (transaction as Record<string, unknown>)?.hash,
    receipt?.transactionHash,
    settlement?.txHash,
    settlement?.transactionHash,
    settlement?.hash,
  ];

  for (const candidate of candidates) {
    if (isEvmTxHash(candidate)) return candidate;
  }

  return null;
}

function buildExplorerUrl(network: string, txHash: string | null): string | null {
  if (!txHash) return null;

  if (network === "eip155:5042002") {
    const base =
      process.env.PAYLABS_ARC_TESTNET_EXPLORER_TX_BASE ||
      "https://arc-testnet.blockscout.com/tx";

    return `${base.replace(/\/+$/, "")}/${txHash}`;
  }

  return null;
}

// ─── Verify + Settle ──────────────────────────────────────────

/**
 * Verify and settle an x402 payment using BatchFacilitatorClient.
 *
 * Called when the seller receives a retry request with PAYMENT-SIGNATURE header.
 * The payment signature is base64-encoded JSON containing the signed payload.
 *
 * Fails closed: if verification or settlement fails, returns ok:false.
 * Never exposes raw Gateway response — only safe metadata.
 */
export async function verifyAndSettlePayment(
  paymentSignatureBase64: string,
  requirements: X402ChallengeRequirements
): Promise<VerifyAndSettleResult> {
  const FacilitatorClient = getBatchFacilitatorClient();
  if (!FacilitatorClient) {
    return {
      ok: false,
      settled: false,
      error: "x402-batching SDK not available — cannot verify payment",
    };
  }

  let paymentPayload: unknown;
  try {
    const decoded = Buffer.from(paymentSignatureBase64, "base64").toString("utf-8");
    paymentPayload = JSON.parse(decoded);
  } catch {
    return {
      ok: false,
      settled: false,
      error: "Invalid PAYMENT-SIGNATURE header (not valid base64 JSON)",
    };
  }

  const facilitator = new FacilitatorClient({
    url: "https://gateway-api-testnet.circle.com",
  });

  // ── Verify ─────────────────────────────────────────────────
  try {
    const verifyResult = await facilitator.verify(paymentPayload, requirements);
    if (!verifyResult?.isValid) {
      console.error("[seller-challenge] verify FAILED:", {
        isValid: verifyResult?.isValid,
        invalidReason: verifyResult?.invalidReason,
        payer: verifyResult?.payer,
        amount: requirements.amount,
        network: requirements.network,
        payTo: requirements.payTo,
      });
      return {
        ok: false,
        settled: false,
        error: "Payment signature verification failed",
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      settled: false,
      error: `Payment verification error: ${msg}`,
    };
  }

  // ── Settle ─────────────────────────────────────────────────
  try {
    const settleResult = await facilitator.settle(paymentPayload, requirements);
    const settleData = settleResult as Record<string, unknown>;

    // Extract txHash — check multiple possible locations in SDK response
    const txHash = extractTxHash(settleResult);
    const explorerUrl = buildExplorerUrl(requirements.network, txHash);

    // Safe log — keys only, never raw payload or signature
    const txVal = settleData.transaction;
    console.log("[x402-settle-proof]", {
      settled: true,
      hasTxHash: !!txHash,
      txHash,
      explorerUrl,
      settleResultKeys: Object.keys(settleData),
      transactionType: typeof txVal,
      transactionLength: typeof txVal === "string" ? txVal.length : null,
      transactionPrefix: typeof txVal === "string" ? txVal.slice(0, 10) : null,
      transactionIsHexString: isEvmTxHash(txVal),
    });

    return {
      ok: true,
      settled: true,
      paymentMeta: {
        amountAtomic: requirements.amount,
        payTo: requirements.payTo,
        network: requirements.network,
        x402Version: X402_VERSION,
        txHash,
        explorerUrl,
      },
      payer: settleData?.payer as string | undefined,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Settlement failed after verification — log but don't expose internals
    return {
      ok: false,
      settled: false,
      error: `Payment settlement failed: ${msg}`,
    };
  }
}
