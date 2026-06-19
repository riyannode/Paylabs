// POST /api/paylabs/tutor/chat
//
// Tutor Intake Agent + Route x402 Guard Agent.
//
// 1. Tutor Intake Agent classifies user intent (pre-processor only).
// 2. Route x402 Guard Agent charges a tiny route toll via Runner (when enabled).
//
// This endpoint does NOT:
// - create paths
// - create receipts
// - create unlocks
// - call Circle directly
// - call wallet APIs directly
// - call contracts directly
// - write to DB
//
// The only payment: route toll via ArcLayer Runner (when PAYLABS_ROUTE_TOLL_ENABLED=true).
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

  // Validate wallet format if provided (optional, but required when toll enabled)
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

    // If route toll is enabled and payment failed, return 402
    const tollFailed =
      result.routeTollEnabled &&
      result.routeTollRequired &&
      result.routePaymentStatus !== "completed" &&
      result.routePaymentStatus !== "skipped" &&
      result.routePaymentStatus !== "skipped_clarification" &&
      result.routePaymentStatus !== "skipped_no_route";

    if (tollFailed) {
      return NextResponse.json(
        {
          error: result.routePaymentError || result.error || "Route toll payment failed",
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
          route_toll_enabled: result.routeTollEnabled,
          route_toll_required: result.routeTollRequired,
          route_toll_amount_usdc: result.routeTollAmountUsdc,
          route_payment_status: result.routePaymentStatus,
          route_payment_error: result.routePaymentError,
          route_input_hash: result.routeInputHash,
        },
        { status: 402 }
      );
    }

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
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
      // Route toll fields
      route_toll_enabled: result.routeTollEnabled,
      route_toll_required: result.routeTollRequired,
      route_toll_amount_usdc: result.routeTollAmountUsdc,
      route_payment_id: result.routePaymentId,
      route_payment_ref: result.routePaymentRef,
      route_settlement_ref: result.routeSettlementRef,
      route_payment_status: result.routePaymentStatus,
      route_input_hash: result.routeInputHash,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
