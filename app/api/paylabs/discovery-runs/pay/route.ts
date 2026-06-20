// POST /api/paylabs/discovery-runs/pay
//
// Unified discovery payment + agent pipeline execution.
// 1. Validates input
// 2. Runs full LangGraph pipeline (12 agents, all LLM-backed)
// 3. Creates 7 nanopayment rows + updates based on agent execution
// 4. Returns combined results: pipeline output + payment state
//
// No separate agent capability endpoints needed.
// No skeleton code. Real LLM calls. Real nanopayment tracking.

import { NextRequest, NextResponse } from "next/server";
import { runDiscoveryPipeline } from "@/lib/paylabs/discovery-pipeline";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
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

  const flags = getPaymentFlags();

  // ── Run unified pipeline ─────────────────────────────────────
  try {
    const result = await runDiscoveryPipeline({
      userWallet: user_wallet,
      goal: goal.trim(),
      routeTier,
      budgetUsdc: typeof budget_usdc === "number" ? budget_usdc : 0.01,
    });

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        status: "pipeline_error",
        discovery_run_id: result.discoveryRunId,
        error: result.error,
        nanopayments: result.nanopayments,
        agents_run: result.pipeline.agentsRun,
        agents_failed: result.pipeline.agentsFailed,
      }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      status: result.sourcePathStatus === "proposed" ? "paid_path_available" : "discovery_only",
      discovery_run_id: result.discoveryRunId,
      source_path_id: result.sourcePathId,
      source_path_status: result.sourcePathStatus,
      route_tier: routeTier,
      payment_route: flags.paymentRoute,
      nanopayments: result.nanopayments,
      pipeline: {
        agents_run: result.pipeline.agentsRun,
        agents_failed: result.pipeline.agentsFailed,
        selected_sources_count: result.pipeline.selectedSources.length,
        verified_sources_count: result.pipeline.verifiedSources.length,
        estimated_total_usdc: result.pipeline.estimatedTotalUsdc,
      },
      selected_sources: result.pipeline.selectedSources,
      verified_sources: result.pipeline.verifiedSources,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, status: "error", error: msg },
      { status: 500 }
    );
  }
}
