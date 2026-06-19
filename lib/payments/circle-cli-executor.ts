/**
 * Circle CLI Payment Executor
 * Uses Circle CLI for USDC transfers on Arc.
 * Placeholder — implement when Circle CLI integration is ready.
 */
import type { PaymentExecutor, PaymentQuoteInput, PaymentQuoteResult, PaymentPayInput, PaymentPayResult, PaymentReceiptResult } from "./types";

export class CircleCliPaymentExecutor implements PaymentExecutor {
  async quote(_input: PaymentQuoteInput): Promise<PaymentQuoteResult> {
    // TODO: Implement Circle CLI quote
    return { ok: false, error: "Circle CLI executor not yet implemented" };
  }

  async pay(_input: PaymentPayInput): Promise<PaymentPayResult> {
    // TODO: Implement Circle CLI pay
    return { ok: false, error: "Circle CLI executor not yet implemented" };
  }

  async getReceipt(_paymentId: string): Promise<PaymentReceiptResult> {
    // TODO: Implement Circle CLI receipt
    return { ok: false, error: "Circle CLI executor not yet implemented" };
  }
}
