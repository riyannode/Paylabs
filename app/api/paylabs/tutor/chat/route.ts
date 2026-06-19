// POST /api/paylabs/tutor/chat
//
// Tutor Intake Agent — classifies user intent and returns route recommendation.
// This is a PRE-PROCESSOR only. It does NOT:
// - create paths
// - create receipts
// - create unlocks
// - call Runner
// - call Circle
// - call wallet APIs
// - call contracts
// - write to DB
//
// User still must manually click "Use Recommendation" and then "Propose Path".

import { NextRequest, NextResponse } from "next/server";
import { runTutorIntake } from "@/lib/ai-tutor/intake-graph";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { message, wallet, current_goal, current_budget_usdc } = body;

  // Validate message
  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json(
      { error: "message is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  // Validate wallet format if provided (optional)
  if (wallet !== undefined) {
    if (typeof wallet !== "string" || !wallet.startsWith("0x") || wallet.length !== 42) {
      return NextResponse.json(
        { error: "wallet must be a valid EVM address (0x... 42 chars)" },
        { status: 400 }
      );
    }
  }

  // Validate budget if provided (optional)
  if (current_budget_usdc !== undefined) {
    if (typeof current_budget_usdc !== "number" || current_budget_usdc < 0) {
      return NextResponse.json(
        { error: "current_budget_usdc must be a non-negative number" },
        { status: 400 }
      );
    }
  }

  try {
    const result = await runTutorIntake({
      message: message.trim(),
      wallet,
      currentGoal: current_goal,
      currentBudgetUsdc: current_budget_usdc,
    });

    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({
      assistant_message: result.assistantMessage,
      normalized_goal: result.normalizedGoal,
      recommended_route_tier: result.recommendedRouteTier,
      route_label: result.routeLabel,
      learning_level: result.learningLevel,
      suggested_budget_usdc: result.suggestedBudgetUsdc,
      confidence: result.confidence,
      needs_clarification: result.needsClarification,
      clarification_question: result.clarificationQuestion,
      reasoning: result.reasoning,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
