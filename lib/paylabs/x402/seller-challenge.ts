/**
 * Seller-Side x402 Gateway Challenge Middleware
 *
 * Returns HTTP 402 with proper PAYMENT-REQUIRED header containing
 * Circle Gateway x402 payment requirements. The buyer uses this
 * challenge to create a signed payment payload via BatchEvmScheme.
 *
 * Calls settle() as the sole verification+payment path — no prior
 * verify() step. settle() validates signatures before committing
 * funds, which is Circle's preferred approach for latency-sensitive
 * production deployments (verify() is only useful for diagnostics).
 * Note: settlement failure blocks handler execution — the service
 * must not proceed and should return 402 to the buyer.
 *
 * Flow:
 *   1. Buyer calls seller endpoint (no payment)
 *   2. Seller returns 402 + PAYMENT-REQUIRED header (base64 JSON)
 *   3. Buyer signs payment payload, retries with PAYMENT-SIGNATURE header
 *   4. Seller settles payment via BatchFacilitatorClient.settle()
 *   5. Seller executes agent logic and returns result
 */

import { createRequire } from "node:module";
import {
  buildBatchResolverUrl,
  buildSettlementUrl,
  buildTxExplorerUrl,
  isUuid,
} from "./payment-links";

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

export type X402TransferStatus =
  | "received"
  | "batched"
  | "confirmed"
  | "completed"
  | "failed";

export interface VerifyAndSettleResult {
  ok: boolean;
  /** Gateway accepted/queued — NOT final onchain settlement */
  settled: boolean;
  /** Gateway accepted the payment (settle success=true) */
  gatewayAccepted?: boolean;
  /** Circle transfer status — null until polled from /v1/x402/transfers/{id} */
  transferStatus?: X402TransferStatus | null;
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
    /** Circle x402 transfer/settlement UUID — do not show raw in chat UI */
    settlementId: string | null;
    /** Backend settlement resolver URL */
    settlementUrl: string | null;
    /** Batch settlement tx hash — null until batch settles */
    batchTxHash: string | null;
    /** Batch settlement explorer URL — null until batch settles */
    batchExplorerUrl: string | null;
    /** Backend batch resolver URL */
    batchResolverUrl: string | null;
    /** Gateway accepted the payment */
    gatewayAccepted: boolean;
    /** Circle transfer status */
    transferStatus: X402TransferStatus | null;
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

function extractSettlementId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const obj = value as Record<string, unknown>;
  const transactionObj =
    obj.transaction && typeof obj.transaction === "object"
      ? (obj.transaction as Record<string, unknown>)
      : null;

  const receipt = obj.receipt as Record<string, unknown> | undefined;
  const settlement = obj.settlement as Record<string, unknown> | undefined;
  const transfer = obj.transfer as Record<string, unknown> | undefined;

  const candidates = [
    obj.id,
    obj.settlementId,
    obj.settlement_id,
    obj.transferId,
    obj.transfer_id,
    typeof obj.transaction === "string" ? obj.transaction : null,
    transactionObj?.id,
    receipt?.id,
    settlement?.id,
    settlement?.settlementId,
    settlement?.transferId,
    transfer?.id,
  ];

  for (const candidate of candidates) {
    if (isUuid(candidate)) return candidate;
  }

  return null;
}

// ─── Verify + Settle ──────────────────────────────────────────

/**
 * Settle an x402 payment using BatchFacilitatorClient.
 *
 * Per Circle official docs: use settle() directly rather than calling
 * verify() then settle() in production. settle() verifies the signature
 * internally before locking funds.
 *
 * settle() success = Gateway accepted/queued, NOT final onchain settlement.
 * Onchain settlement happens later via batch submitBatch tx.
 *
 * Fails closed: if settlement fails, returns ok:false.
 * Never exposes raw Gateway response — only safe metadata.
 */
export async function verifyAndSettlePayment(
  paymentSignatureBase64: string,
  requirements: X402ChallengeRequirements,
): Promise<VerifyAndSettleResult> {
  const FacilitatorClient = getBatchFacilitatorClient();
  if (!FacilitatorClient) {
    return {
      ok: false,
      settled: false,
      gatewayAccepted: false,
      transferStatus: null,
      error: "x402-batching SDK not available — cannot settle payment",
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
      gatewayAccepted: false,
      transferStatus: null,
      error: "Invalid PAYMENT-SIGNATURE header (not valid base64 JSON)",
    };
  }

  const facilitator = new FacilitatorClient({
    url:
      process.env.CIRCLE_GATEWAY_BASE_URL ||
      process.env.PAYLABS_GATEWAY_API_URL?.replace(/\/v1\/?$/, "") ||
      "https://gateway-api-testnet.circle.com",
  });

  // Circle Gateway's settle() endpoint is optimized for low latency and guarantees settlement.
  // Circle recommends using settle() directly rather than verify() followed by settle()
  // in production seller flows. verify() remains useful for diagnostics/custom preflight checks.
  //
  // IMPORTANT: this is not a "no verification" path.
  // Handler execution is still gated on successful settlement. If settle() fails,
  // the seller must return an error/402 and the agent/service handler must not run.
  try {
    const settleResult = await facilitator.settle(paymentPayload, requirements);
    const settleData = settleResult as Record<string, unknown>;

    // Check success === true (Circle official: success boolean field)
    if (settleData.success !== true) {
      const reason =
        typeof settleData.errorReason === "string"
          ? settleData.errorReason
          : "unknown_settlement_failure";

      console.error("[seller-challenge] settle FAILED:", {
        success: settleData.success,
        errorReason: reason,
        amount: requirements.amount,
        network: requirements.network,
        payTo: requirements.payTo,
      });

      return {
        ok: false,
        settled: false,
        gatewayAccepted: false,
        transferStatus: null,
        error: `Payment settlement failed: ${reason}`,
        payer: typeof settleData.payer === "string" ? settleData.payer : undefined,
      };
    }

    // Extract txHash — check multiple possible locations in SDK response
    const txHash = extractTxHash(settleResult);
    const explorerUrl = buildTxExplorerUrl(txHash);
    const settlementId = extractSettlementId(settleResult);
    const settlementUrl = buildSettlementUrl(settlementId);
    const batchResolverUrl = buildBatchResolverUrl(settlementId);

    // Safe log — booleans only, never raw payload or signature
    console.log("[x402-settle-proof]", {
      gatewayAccepted: true,
      hasTxHash: !!txHash,
      hasSettlementId: !!settlementId,
      hasBatchResolverUrl: !!batchResolverUrl,
    });

    return {
      ok: true,
      settled: true,
      gatewayAccepted: true,
      transferStatus: null, // not onchain yet — polled later
      paymentMeta: {
        amountAtomic: requirements.amount,
        payTo: requirements.payTo,
        network: requirements.network,
        x402Version: X402_VERSION,
        txHash,
        explorerUrl,
        settlementId,
        settlementUrl,
        batchTxHash: null,
        batchExplorerUrl: null,
        batchResolverUrl,
        gatewayAccepted: true,
        transferStatus: null,
      },
      payer: typeof settleData.payer === "string" ? settleData.payer : undefined,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      settled: false,
      gatewayAccepted: false,
      transferStatus: null,
      error: `Payment settlement failed: ${msg}`,
    };
  }
}
