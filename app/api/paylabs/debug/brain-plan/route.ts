/**
 * POST /api/paylabs/debug/brain-plan
 *
 * Diagnostic endpoint: runs Brain LLM planner directly (no x402, no payment).
 * Returns only safe fields — no raw LLM output, no chain-of-thought, no secrets.
 *
 * Body: { "userGoal": "...", "routeTier": "auto" | "easy" | "normal" | "advanced" }
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userGoal = typeof body?.userGoal === "string" ? body.userGoal.trim() : "";
    const routeTier = typeof body?.routeTier === "string" ? body.routeTier.trim() : "auto";

    if (!userGoal) {
      return NextResponse.json(
        { ok: false, error: "userGoal is required" },
        { status: 400 },
      );
    }

    const VALID_TIERS = new Set(["auto", "easy", "normal", "advanced"]);
    if (!VALID_TIERS.has(routeTier)) {
      return NextResponse.json(
        { ok: false, error: `routeTier must be one of: auto, easy, normal, advanced (got "${routeTier}")` },
        { status: 400 },
      );
    }

    const { runBrainPlannerGraph } = await import(
      "@/lib/paylabs/langgraph/brain/brain-planner-graph"
    );

    const discoveryRunId = `debug-${crypto.randomUUID()}`;

    const result = await runBrainPlannerGraph({
      discoveryRunId,
      userGoal,
      routeTier: routeTier as unknown as "easy" | "normal" | "advanced",
      userBudgetUsdc: 0.01,
      userWallet: "0x0000000000000000000000000000000000000000",
    });

    const bp = result.brainPlanning;
    const VALID_TIER_SET = new Set(["easy", "normal", "advanced"]);
    const rawHint: string | undefined = bp?.route_tier_hint;
    const hintValid = rawHint !== undefined && VALID_TIER_SET.has(rawHint);

    // Safe fields only
    return NextResponse.json({
      ok: result.ok,
      route_tier_hint: hintValid ? rawHint : (rawHint ?? "none"),
      route_tier_hint_valid: hintValid,
      selected_macro_nodes_count: bp?.selected_macro_nodes?.length ?? 0,
      selected_services_count: bp?.selected_services?.length ?? 0,
      suggested_query_variants_count: bp?.suggested_query_variants?.length ?? 0,
      errorClass: result.error ? result.error.slice(0, 160) : null,
      progressSummaries: result.progressSummaries,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg.slice(0, 200) },
      { status: 500 },
    );
  }
}
