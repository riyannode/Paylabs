// POST /api/paylabs/tutor/propose
// Compatibility wrapper — redirects to /api/paylabs/learning-paths/propose
// Uses the same LangGraph proposeLearningPath graph.

import { NextRequest, NextResponse } from "next/server";
import { proposeLearningPath } from "@/lib/ai-tutor/graph";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { goal, budget_usdc, user_wallet } = body;

  if (!goal || !budget_usdc || budget_usdc <= 0) {
    return NextResponse.json(
      { error: "Goal and positive budget required" },
      { status: 400 }
    );
  }
  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  try {
    const result = await proposeLearningPath({
      userWallet: user_wallet,
      goal,
      budgetUsdc: Number(budget_usdc),
    });

    if (result.error && !result.pathId) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const path = (result.verifiedLessons as Record<string, unknown>[] || []).map((v, i) => {
      const selected = (result.selectedLessons as Record<string, unknown>[] || []).find(
        (s) => s.lesson_id === v.lesson_id
      );
      return {
        id: v.lesson_id,
        order_index: i,
        source_ok: v.source_ok,
        creator_ok: v.creator_ok,
        verification_reason: v.verification_reason,
        price_usdc: selected?.price_usdc || 0,
        reason: selected?.reason || "",
        title: selected?.title || "",
        slug: selected?.slug || "",
      };
    });

    return NextResponse.json({
      path_id: result.pathId,
      path_status: result.pathStatus,
      goal,
      budget_usdc,
      path,
      total_usdc: result.estimatedTotalUsdc || 0,
      remaining_usdc: result.remainingUsdc || 0,
      rejected: result.rejectedLessons || [],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
