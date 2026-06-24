/**
 * Customer Entry Payment — x402 Gate
 *
 * Customer (Circle User-Controlled Wallet) signs ONE x402 payment
 * to Brain/platform entry endpoint BEFORE internal delegated runtime.
 *
 * Flow:
 *   1. Backend computes quote → returns x402 challenge (HTTP 402)
 *   2. Customer wallet signs x402 challenge (frontend SDK)
 *   3. Customer retries with PAYMENT-SIGNATURE header
 *   4. Backend verifies + settles via BatchFacilitatorClient
 *   5. Only after settlement → run internal delegated runtime
 *
 * Client-side signing requirement:
 *   Frontend MUST use @circle-fin/x402-batching BatchEvmScheme.createPaymentPayload()
 *   to sign the EIP-712 authorization. The SDK handles the validity window buffer
 *   (GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS = 604900s). Raw EIP-712 signing will
 *   produce authorization_validity_too_short errors from Gateway.
 *
 *   After BatchEvmScheme returns {x402Version, payload}, the client MUST wrap:
 *     { x402Version, payload, resource: challenge.resource, accepted: requirement }
 *   Then base64-encode that JSON as the PAYMENT-SIGNATURE header value.
 *
 * Internal edges remain unchanged (platform DCW wallets).
 * Customer signs only ONCE for the entry payment.
 */

import {
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
  X402_VERSION,
} from "./seller-challenge";
import type { X402ChallengeRequirements } from "./seller-challenge";

// ─── Types ────────────────────────────────────────────────────

export interface CustomerEntryPaymentResult {
  ok: boolean;
  settled: boolean;
  /** Safe payment metadata (no raw signatures, no EIP-712 data) */
  paymentMeta?: {
    amountAtomic: string;
    payTo: string;
    network: string;
    x402Version: number;
    txHash: string | null;
    explorerUrl: string | null;
    settlementId: string | null;
    settlementUrl: string | null;
    batchTxHash: string | null;
    batchExplorerUrl: string | null;
    batchResolverUrl: string | null;
  };
  payer?: string;
  error?: string;
}

export interface CustomerEntryPaymentData {
  customer_wallet_address: string;
  customer_wallet_type: "circle_user_controlled" | "external_eoa";
  customer_auth_method?: "social" | "email" | "pin";
  entry_payment_status: "pending" | "paid" | "failed";
  entry_payment_amount_usdc: number;
  entry_payment_settlement_id?: string | null;
  entry_payment_tx_hash?: string | null;
  entry_payment_explorer_url?: string | null;
  entry_payment_settlement_url?: string | null;
  entry_payment_batch_tx_hash?: string | null;
  entry_payment_batch_explorer_url?: string | null;
  entry_payment_batch_resolver_url?: string | null;
  selected_tier: string;
  quote_planned_cost_usdc: number;
  quote_expected_payment_edges: number;
}

// ─── Constants ────────────────────────────────────────────────

/** Env var for the platform/Brain entry payment seller wallet address.
 *  Falls back to PAYLABS_BRAIN_SELLER_WALLET_ADDRESS if not set. */
const ENTRY_SELLER_ENV = "PAYLABS_ENTRY_PAYMENT_SELLER_WALLET_ADDRESS";
const BRAIN_SELLER_ENV = "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS";

// ─── Build Customer Entry Challenge ───────────────────────────

/**
 * Build the x402 challenge for customer entry payment.
 * Returns the challenge object + base64-encoded PAYMENT-REQUIRED header value.
 *
 * @param plannedCostUsdc - The quoted cost from quoteDelegatedRun()
 * @param resourceUrl - Optional resource URL for the challenge
 */
export function buildCustomerEntryChallenge(
  plannedCostUsdc: number,
  resourceUrl?: string,
  bodyHash?: string
): { challenge: ReturnType<typeof buildX402Challenge>; headerValue: string } {
  const sellerAddress = resolveEntrySellerAddress();
  // Convert USDC to atomic units (6 decimals)
  const amountAtomic = Math.round(plannedCostUsdc * 1_000_000).toString();

  const challenge = buildX402Challenge(sellerAddress, amountAtomic, resourceUrl, bodyHash);
  const headerValue = encodeChallengeHeader(challenge);

  return { challenge, headerValue };
}

// ─── Verify + Settle Customer Entry Payment ───────────────────

/**
 * Verify and settle the customer's x402 entry payment.
 * Uses the same BatchFacilitatorClient as internal edges.
 *
 * @param paymentSignatureBase64 - Base64-encoded payment payload from PAYMENT-SIGNATURE header
 * @param plannedCostUsdc - Expected cost (for amount validation)
 */
export async function verifyAndSettleCustomerEntry(
  paymentSignatureBase64: string,
  plannedCostUsdc: number
): Promise<CustomerEntryPaymentResult> {
  const sellerAddress = resolveEntrySellerAddress();
  const amountAtomic = Math.round(plannedCostUsdc * 1_000_000).toString();

  const requirements: X402ChallengeRequirements = {
    scheme: "exact",
    network: "eip155:5042002", // Arc Testnet
    asset: "0x3600000000000000000000000000000000000000", // USDC
    amount: amountAtomic,
    payTo: sellerAddress.toLowerCase(),
    maxTimeoutSeconds: 604900, // MUST match GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };

  const result = await verifyAndSettlePayment(paymentSignatureBase64, requirements);

  return {
    ok: result.ok,
    settled: result.settled,
    paymentMeta: result.paymentMeta,
    payer: result.payer,
    error: result.error,
  };
}

// ─── Build Entry Payment Data for DB Storage ──────────────────

/**
 * Build the safe entry payment data for Supabase storage.
 * NEVER stores raw signatures, EIP-712 data, or secrets.
 */
export function buildCustomerEntryPaymentData(
  customerWalletAddress: string,
  quote: { routeTier: string; plannedCostUsdc: number; expectedPaymentEdges: number },
  result: CustomerEntryPaymentResult,
  walletType: "circle_user_controlled" | "external_eoa" = "external_eoa"
): CustomerEntryPaymentData {
  return {
    customer_wallet_address: customerWalletAddress.toLowerCase(),
    customer_wallet_type: walletType,
    entry_payment_status: result.settled ? "paid" : "failed",
    entry_payment_amount_usdc: quote.plannedCostUsdc,
    entry_payment_settlement_id: result.paymentMeta?.settlementId ?? null,
    entry_payment_tx_hash: result.paymentMeta?.txHash ?? null,
    entry_payment_explorer_url: result.paymentMeta?.explorerUrl ?? null,
    entry_payment_settlement_url: result.paymentMeta?.settlementUrl ?? null,
    entry_payment_batch_tx_hash: result.paymentMeta?.batchTxHash ?? null,
    entry_payment_batch_explorer_url: result.paymentMeta?.batchExplorerUrl ?? null,
    entry_payment_batch_resolver_url: result.paymentMeta?.batchResolverUrl ?? null,
    selected_tier: quote.routeTier,
    quote_planned_cost_usdc: quote.plannedCostUsdc,
    quote_expected_payment_edges: quote.expectedPaymentEdges,
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function resolveEntrySellerAddress(): string {
  // Prefer dedicated entry wallet, fallback to Brain seller wallet
  const addr = process.env[ENTRY_SELLER_ENV] || process.env[BRAIN_SELLER_ENV];
  if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    throw new Error(
      `config_error: ${ENTRY_SELLER_ENV} or ${BRAIN_SELLER_ENV} must be a valid EVM address.`
    );
  }
  return addr;
}

export { ENTRY_SELLER_ENV, X402_VERSION };
