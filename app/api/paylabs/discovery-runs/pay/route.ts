// POST /api/paylabs/discovery-runs/pay
//
// Enqueue a discovery run for async background execution.
// Returns HTTP 202 immediately with discovery_run_id.
// Worker process picks up queued runs and executes LangGraph pipeline.
//
// Poll status via: GET /api/paylabs/discovery-runs/[id]/status

import { NextRequest, NextResponse } from "next/server";
import { enqueueDiscoveryRun } from "@/lib/paylabs/discovery-pipeline";
import { isValidExternalTier, DEFAULT_EXTERNAL_TIER } from "@/lib/paylabs/route-tier";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { user_wallet, goal, budget_usdc } = body;
  const rawTier = (body.route_tier || DEFAULT_EXTERNAL_TIER).toLowerCase();
  const routeTier = isValidExternalTier(rawTier) ? rawTier : DEFAULT_EXTERNAL_TIER;

  // ── Validate ─────────────────────────────────────────────────
  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address (0x... 42 chars)" },
      { status: 400 }
    );
  }

  if (!goal || typeof goal !== "string" || !goal.trim()) {
    return NextResponse.json(
      { error: "goal is required (the user's learning/research goal)" },
      { status: 400 }
    );
  }

  // ── Enqueue ──────────────────────────────────────────────────
  try {
    const result = await enqueueDiscoveryRun({
      userWallet: user_wallet,
      goal: goal.trim(),
      routeTier,
      budgetUsdc: typeof budget_usdc === "number" ? budget_usdc : 0.01,
    });

    if (!result.ok) {
      // Budget validation failure — 400, no rows created
      if (result.budgetError) {
        return NextResponse.json({
          ok: false,
          status: "budget_below_minimum",
          route_tier: result.budgetError.routeTier,
          public_label: result.budgetError.publicLabel,
          min_user_budget_usdc: result.budgetError.minUserBudgetUsdc,
          provided_budget_usdc: result.budgetError.providedBudgetUsdc,
          error: result.error,
        }, { status: 400 });
      }

      // Enqueue failure — 500
      return NextResponse.json({
        ok: false,
        status: "enqueue_failed",
        error: result.error,
      }, { status: 500 });
    }

    // Success — 202 Accepted (queued for background execution)
    return NextResponse.json({
      ok: true,
      status: "queued",
      discovery_run_id: result.discoveryRunId,
      route_tier: routeTier,
      nanopayments: result.nanopayments,
      message: "Discovery run queued. Poll GET /api/paylabs/discovery-runs/{id}/status for progress.",
    }, { status: 202 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, status: "error", error: msg },
      { status: 500 }
    );
  }
}
