// POST /api/paylabs/tutor/route-toll
//
// Route x402 Guard — charges route toll via Runner after explicit user confirmation.
// This endpoint is called ONLY when user clicks "Pay route toll & use recommendation".
//
// It does NOT:
// - create paths
// - create receipts
// - create unlocks
// - call Circle directly
// - call wallet APIs directly
// - call contracts directly
// - write to DB
//
// It DOES:
// - validate inputs
// - compute deterministic input hash
// - execute route toll payment via ArcLayer Runner
// - return payment proof
//
// The proof returned here must be passed to /api/paylabs/learning-paths/propose
// as headers when PAYLABS_ROUTE_TOLL_ENABLED=true.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { executeRouteTollPayment } from "@/lib/arclayer-runner/route-toll";

// ─── Route toll amounts from env ─────────────────────────────────

const ROUTE_TOLL_DEFAULTS: Record<string, string> = {
  normal: "0.000001",
  advanced: "0.000002",
  premium: "0.000003",
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getRouteTollAmount(tier: string): string {
  switch (tier) {
    case "normal":
      return process.env.PAYLABS_ROUTE_TOLL_NORMAL_USDC || ROUTE_TOLL_DEFAULTS.normal;
    case "advanced":
      return process.env.PAYLABS_ROUTE_TOLL_ADVANCED_USDC || ROUTE_TOLL_DEFAULTS.advanced;
    case "premium":
      return process.env.PAYLABS_ROUTE_TOLL_PREMIUM_USDC || ROUTE_TOLL_DEFAULTS.premium;
    default:
      return ROUTE_TOLL_DEFAULTS.normal;
  }
}

const ROUTE_LABELS: Record<string, string> = {
  normal: "Easy Path",
  advanced: "Builder Path",
  premium: "Expert Path",
};

export async function POST(req: NextRequest) {
  // Check if route toll is enabled
  if (process.env.PAYLABS_ROUTE_TOLL_ENABLED !== "true") {
    return NextResponse.json(
      { error: "Route toll is not enabled" },
      { status: 400 }
    );
  }

  const body = await req.json();
  const { user_wallet, route_tier, route_label, normalized_goal, user_message } = body;

  // Validate required fields
  if (!user_wallet || typeof user_wallet !== "string" || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address (0x... 42 chars)" },
      { status: 400 }
    );
  }

  if (!route_tier || !["normal", "advanced", "premium"].includes(route_tier)) {
    return NextResponse.json(
      { error: "route_tier must be normal, advanced, or premium" },
      { status: 400 }
    );
  }

  if (!normalized_goal || typeof normalized_goal !== "string") {
    return NextResponse.json(
      { error: "normalized_goal is required" },
      { status: 400 }
    );
  }

  if (!user_message || typeof user_message !== "string") {
    return NextResponse.json(
      { error: "user_message is required" },
      { status: 400 }
    );
  }

  // Validate route toll wallet
  const routeTollWallet = process.env.PAYLABS_ROUTE_TOLL_WALLET;
  if (!routeTollWallet || !routeTollWallet.startsWith("0x") || routeTollWallet.length !== 42) {
    return NextResponse.json(
      { error: "Route toll wallet not configured" },
      { status: 500 }
    );
  }
  if (routeTollWallet.toLowerCase() === ZERO_ADDRESS) {
    return NextResponse.json(
      { error: "Route toll wallet is zero address" },
      { status: 500 }
    );
  }

  // Compute toll amount
  const amountUsdc = getRouteTollAmount(route_tier);
  const label = route_label || ROUTE_LABELS[route_tier] || "Easy Path";

  // Compute deterministic input hash for audit trail
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        userMessage: user_message,
        normalizedGoal: normalized_goal,
        recommendedRouteTier: route_tier,
        amountUsdc,
        userWallet: user_wallet,
      })
    )
    .digest("hex");

  try {
    // Execute route toll payment via Runner
    const result = await executeRouteTollPayment({
      userWallet: user_wallet,
      routeTier: route_tier,
      routeLabel: label,
      amountUsdc,
      routeTollWallet,
      inputHash,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.error || "Route toll payment failed",
          route_payment_status: "failed",
        },
        { status: 402 }
      );
    }

    // Return proof — caller must pass this to /api/paylabs/learning-paths/propose
    return NextResponse.json({
      route_payment_id: result.paymentId,
      route_payment_ref: result.paymentRef,
      route_settlement_ref: result.settlementRef,
      route_input_hash: inputHash,
      route_payment_status: "completed",
      route_tier,
      route_label: label,
      route_toll_amount_usdc: Number(amountUsdc),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
