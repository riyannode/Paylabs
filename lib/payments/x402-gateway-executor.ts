/**
 * x402 Gateway Payment Executor
 *
 * PaymentExecutor interface for discovery fee payments.
 * Actual settlement uses @circle-fin/x402-batching BatchFacilitatorClient
 * in the API route layer (apps/vercel-backend/src/routes/payments.ts).
 *
 * This executor provides quote() and getReceipt() for LangGraph agents.
 * pay() delegates to the API route which handles verify → settle via SDK.
 */

import type {
  PaymentExecutor,
  PaymentQuoteInput,
  PaymentQuoteResult,
  PaymentPayInput,
  PaymentPayResult,
  PaymentReceiptResult,
} from "@/lib/paylabs/x402/types";

export class X402GatewayPaymentExecutor implements PaymentExecutor {
  async quote(input: PaymentQuoteInput): Promise<PaymentQuoteResult> {
    const discoveryFeeEnabled = process.env.PAYLABS_X402_DISCOVERY_FEE_ENABLED === "true";

    if (!discoveryFeeEnabled) {
      return {
        ok: false,
        error: "Discovery fee payments are disabled. Set PAYLABS_X402_DISCOVERY_FEE_ENABLED=true.",
      };
    }

    return {
      ok: true,
      amountUsdc: input.amountUsdc,
      creatorAmountUsdc: 0, // Creator payout handled in PR #17
      agentFeeUsdc: 0.000007, // 7 agents × 0.000001
      treasuryFeeUsdc: input.amountUsdc - 0.000007,
    };
  }

  async pay(_input: PaymentPayInput): Promise<PaymentPayResult> {
    // Actual discovery fee settlement happens through
    // /api/paylabs/payments/discovery endpoint which handles:
    //   verify x-payment → Gateway settle → DB record
    //
    // The pay() method is called by LangGraph agents which don't have
    // direct access to signed authorizations. The real payment happens
    // in the API route layer.
    return {
      ok: false,
      error:
        "Direct pay() not supported for x402 executor. " +
        "Use /api/paylabs/payments/discovery endpoint with signed authorization.",
    };
  }

  async getReceipt(paymentId: string): Promise<PaymentReceiptResult> {
    // Look up payment in discovery_payments table
    const { supabaseAdmin } = await import("@/lib/supabase/server");

    const { data } = await supabaseAdmin()
      .from("paylabs_discovery_payments")
      .select("*")
      .eq("id", paymentId)
      .single();

    if (!data) {
      return { ok: false, error: `Payment ${paymentId} not found` };
    }

    const statusMap: Record<string, PaymentReceiptResult["status"]> = {
      paid: "completed",
      authorized: "pending",
      settlement_pending: "pending",
      failed: "failed",
      quoted: "pending",
      setup_required: "failed",
    };

    return {
      ok: true,
      paymentId: data.id,
      status: statusMap[data.status] || "pending",
      amountUsdc: data.amount_usdc,
      creatorWallet: data.user_wallet,
      txHash: data.x402_settlement_ref || data.x402_payment_ref || undefined,
    };
  }
}
