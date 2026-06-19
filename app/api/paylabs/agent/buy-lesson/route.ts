// POST /api/paylabs/agent/buy-lesson
// Agent-triggered lesson purchase through ArcLayer Runner.
// Uses LangGraph buyApprovedLesson: policy_guard -> payment_executor.
// No fallback payment ID, no Date.now(), no fake tx hash.

import { NextRequest, NextResponse } from "next/server";
import { buyApprovedLesson } from "@/lib/ai-tutor/graph";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { user_wallet, lesson_id, path_id } = body;

  // Validate inputs — all required, no optional path_id bypass
  if (!user_wallet || !lesson_id || !path_id) {
    return NextResponse.json(
      {
        error:
          "user_wallet, lesson_id, and path_id all required. Agent must not buy without approved path.",
      },
      { status: 400 }
    );
  }
  if (!user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address (0x...)" },
      { status: 400 }
    );
  }

  try {
    const result = await buyApprovedLesson({
      userWallet: user_wallet,
      pathId: path_id,
      lessonId: lesson_id,
    });

    // Policy guard blocked
    if (result.allowed === false) {
      return NextResponse.json(
        {
          error: "Policy check failed",
          reason: result.policyDecision?.reason || "Blocked by policy guard",
          checks: result.policyDecision?.checks,
        },
        { status: 403 }
      );
    }

    // Execution failed
    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 502 }
      );
    }

    // Success
    return NextResponse.json({
      status: "unlocked",
      unlock_id: result.unlockId,
      receipt_id: result.receiptId,
      payment_id: (result.runnerPaymentResult as Record<string, unknown>)?.paymentId,
      settlement_ref: (result.runnerPaymentResult as Record<string, unknown>)?.settlementRef,
      tx_hash: (result.runnerPaymentResult as Record<string, unknown>)?.txHash,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
