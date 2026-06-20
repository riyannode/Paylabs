/**
 * Noop Payment Executor
 * Fail-closed: propose works, payment returns "not configured".
 * No fake payment ID, no fake receipt, no DB row.
 */
import type { PaymentExecutor, PaymentQuoteInput, PaymentQuoteResult, PaymentPayInput, PaymentPayResult, PaymentReceiptResult } from "@/lib/paylabs/x402/types";

export class NoopPaymentExecutor implements PaymentExecutor {
  async quote(_input: PaymentQuoteInput): Promise<PaymentQuoteResult> {
    return { ok: false, error: "Payment executor not configured (noop). Set PAYLABS_PAYMENT_EXECUTOR to enable payments." };
  }

  async pay(_input: PaymentPayInput): Promise<PaymentPayResult> {
    return { ok: false, error: "Payment executor not configured (noop). Set PAYLABS_PAYMENT_EXECUTOR to enable payments." };
  }

  async getReceipt(_paymentId: string): Promise<PaymentReceiptResult> {
    return { ok: false, error: "Payment executor not configured (noop)." };
  }
}
