/**
 * Creator Distribution Payout Endpoint
 *
 * Dynamic x402 payout endpoint for creator/bot/service payments.
 * Builds challenge with payTo=creator/bot/service wallet and amountAtomic.
 * Verifies + settles via verifyAndSettlePayment.
 *
 * Rules:
 * - No raw payment headers in logs
 * - No raw signatures in DB
 * - Strict max payout cap
 * - 402 challenge if no payment header present
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildPaymentRequirements,
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
} from "@/lib/paylabs/x402/seller-challenge";

type PayoutRequestBody = {
  pay_to?: string;
  amount_atomic?: string;
  payout_metadata?: Record<string, string>;
};

const MAX_CREATOR_PAYOUT_ATOMIC = BigInt(1_000_000); // 1 USDC cap

function parseBody(body: unknown): {
  ok: boolean;
  payTo?: string;
  amountAtomic?: string;
  metadata?: Record<string, string>;
  error?: string;
} {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid_json_body" };
  }

  const b = body as PayoutRequestBody;
  const payTo = typeof b.pay_to === "string" ? b.pay_to.trim().toLowerCase() : "";
  const amountAtomic = typeof b.amount_atomic === "string" ? b.amount_atomic.trim() : "";

  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    return { ok: false, error: "invalid_pay_to" };
  }

  if (!/^[0-9]+$/.test(amountAtomic)) {
    return { ok: false, error: "invalid_amount_atomic" };
  }

  const amount = BigInt(amountAtomic);
  if (amount <= BigInt(0)) {
    return { ok: false, error: "amount_must_be_positive" };
  }

  if (amount > MAX_CREATOR_PAYOUT_ATOMIC) {
    return { ok: false, error: "amount_exceeds_creator_payout_cap" };
  }

  return {
    ok: true,
    payTo,
    amountAtomic,
    metadata: b.payout_metadata || {},
  };
}

export async function POST(req: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = parseBody(rawBody);
  if (!parsed.ok || !parsed.payTo || !parsed.amountAtomic) {
    return NextResponse.json(
      { ok: false, error: parsed.error || "invalid_payout_request" },
      { status: 400 },
    );
  }

  const paymentHeader =
    req.headers.get("payment-signature") ??
    req.headers.get("PAYMENT-SIGNATURE") ??
    req.headers.get("x-payment") ??
    req.headers.get("X-Payment");

  if (!paymentHeader) {
    const challenge = buildX402Challenge(parsed.payTo, parsed.amountAtomic, req.url);
    const encoded = encodeChallengeHeader(challenge);

    const response = NextResponse.json(
      {
        ok: false,
        error: "Payment required",
        x402: true,
        payout: true,
        amount_atomic: parsed.amountAtomic,
      },
      { status: 402 },
    );

    response.headers.set("PAYMENT-REQUIRED", encoded);
    return response;
  }

  const requirements = buildPaymentRequirements(parsed.payTo, parsed.amountAtomic);
  const settleResult = await verifyAndSettlePayment(paymentHeader, requirements);

  if (!settleResult.ok || !settleResult.settled) {
    return NextResponse.json(
      {
        ok: false,
        error: settleResult.error || "creator payout verification/settlement failed",
        settled: false,
      },
      { status: 402 },
    );
  }

  return NextResponse.json({
    ok: true,
    settled: true,
    payout: true,
    pay_to: parsed.payTo,
    amount_atomic: parsed.amountAtomic,
    paymentMeta: settleResult.paymentMeta,
  });
}
