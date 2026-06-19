/**
 * Payment Adapter Types
 * Interface for payment execution. Decouples LangGraph from specific payment providers.
 */

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
