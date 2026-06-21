// POST /api/paylabs/tutor/chat
//
// Tutor Intake Agent — FREE classification only.
// Classifies user intent and returns route recommendation + toll quote.
// Does NOT execute any payment. Does NOT call the backend executor. Does NOT return 402.
//
// Route toll payment happens separately at POST /api/paylabs/tutor/route-toll
// (explicit user confirmation required).
//
// User still must manually:
// 1. Click "Pay route toll & use recommendation" (if toll enabled)
// 2. Click "Propose Path"

import { NextRequest, NextResponse } from "next/server";
import { runTutorIntake } from "@/lib/ai/intake-graph";

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
    if (
      typeof wallet !== "string" ||
      !wallet.startsWith("0x") ||
      wallet.length !== 42
    ) {
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
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Always 200 — this is free classification, no payment
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
      // Route toll quote (informational only — no payment executed)
      route_toll_enabled: result.routeTollEnabled,
      route_toll_required: result.routeTollRequired,
      route_toll_amount_usdc: result.routeTollAmountUsdc,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
