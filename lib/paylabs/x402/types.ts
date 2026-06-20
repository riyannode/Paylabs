/**
 * x402 Payment Types & Constants
 *
 * Consolidated from:
 *   - lib/payments/types.ts (PaymentExecutor interface + input/output types)
 *   - lib/payments/receipt.ts (revenue split constants)
 *
 * Single source of truth for:
 *   - PaymentExecutor interface (quote/pay/receipt)
 *   - Revenue split constants (creator/platform/treasury basis points)
 *   - computeSplit() utility
 *
 * Other x402 types live in their own modules:
 *   - DcwSigner, X402BuyerCallInput, X402BuyerCallResult → buyer-transport.ts
 *   - AgentContextPayload, CreateAgentContextInput → agent-context.ts
 */

// ─── Payment Executor Interface ────────────────────────────────
// Used by LangGraph payment agents (payment-quote-agent, payment-executor-agent)
// Implementations: NoopPaymentExecutor, X402GatewayPaymentExecutor

export interface PaymentQuoteInput {
  sourcePathId: string;
  sourcePathItemId: string;
  amountUsdc: number;
  creatorWallet: string;
  sourceUrl: string;
}

export interface PaymentQuoteResult {
  ok: boolean;
  quoteId?: string;
  amountUsdc?: number;
  creatorAmountUsdc?: number;
  agentFeeUsdc?: number;
  treasuryFeeUsdc?: number;
  error?: string;
}

export interface PaymentPayInput {
  userWallet: string;
  sourcePathId: string;
  sourcePathItemId: string;
  amountUsdc: number;
  creatorWallet: string;
  sourceUrl: string;
  creatorAmountUsdc: number;
  agentFeeUsdc: number;
  treasuryFeeUsdc: number;
}

export interface PaymentPayResult {
  ok: boolean;
  paymentId?: string;
  paymentRef?: string;
  settlementRef?: string;
  txHash?: string;
  error?: string;
}

export interface PaymentReceiptResult {
  ok: boolean;
  paymentId?: string;
  status?: "completed" | "failed" | "pending";
  amountUsdc?: number;
  creatorWallet?: string;
  txHash?: string;
  error?: string;
}

export interface PaymentExecutor {
  quote(input: PaymentQuoteInput): Promise<PaymentQuoteResult>;
  pay(input: PaymentPayInput): Promise<PaymentPayResult>;
  getReceipt(paymentId: string): Promise<PaymentReceiptResult>;
}

// ─── Revenue Split Constants ────────────────────────────────────
// Basis points (10000 = 100%)

export const PAYLABS_CREATOR_BPS = 8500; // 85%
export const PAYLABS_PLATFORM_BPS = 1000; // 10%
export const PAYLABS_TREASURY_BPS = 500; // 5%

export function computeSplit(grossAmountUsdc: number) {
  return {
    creator: (grossAmountUsdc * PAYLABS_CREATOR_BPS) / 10000,
    platform: (grossAmountUsdc * PAYLABS_PLATFORM_BPS) / 10000,
    treasury: (grossAmountUsdc * PAYLABS_TREASURY_BPS) / 10000,
  };
}
