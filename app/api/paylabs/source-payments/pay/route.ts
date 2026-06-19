// POST /api/paylabs/source-payments/pay
//
// Pay for a source citation/unlock via the LangGraph payment flow.
// Flow: policy_guard → payment_executor → Runner → paylabs_source_payments

import { NextRequest, NextResponse } from "next/server";
import { executeSourcePayment } from "@/lib/ai-tutor/graph";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { user_wallet, source_path_id, source_path_item_id } = body;

  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  if (!source_path_id) {
    return NextResponse.json(
      { error: "source_path_id is required" },
      { status: 400 }
    );
  }

  if (!source_path_item_id) {
    return NextResponse.json(
      { error: "source_path_item_id is required" },
      { status: 400 }
    );
  }

  try {
    const result = await executeSourcePayment({
      userWallet: user_wallet,
      sourcePathId: source_path_id,
      sourcePathItemId: source_path_item_id,
    });

    if (result.error) {
      return NextResponse.json(
        { error: result.error, policy_decision: result.policyDecision },
        { status: 402 }
      );
    }

    return NextResponse.json({
      ok: true,
      source_payment_id: result.sourcePaymentId,
      receipt_id: result.receiptId,
      payment_adapter_result: result.paymentAdapterResult,
      policy_decision: result.policyDecision,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
