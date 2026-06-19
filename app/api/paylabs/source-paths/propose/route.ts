// POST /api/paylabs/source-paths/propose
//
// Propose a source path using the LangGraph workflow.
// RSSHub-first: picks from paylabs_feed_items, not lessons.
//
// Flow: intent → source_planner → source_verifier → persist

import { NextRequest, NextResponse } from "next/server";
import { proposeSourcePath } from "@/lib/ai-tutor/graph";
import { isValidRouteTier } from "@/lib/ai-tutor/route-config";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { goal, budget_usdc, user_wallet, route_tier } = body;

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

  const tier = route_tier || "normal";
  if (!isValidRouteTier(tier)) {
    return NextResponse.json(
      { error: `Invalid route_tier: "${tier}". Must be normal, advanced, or premium.` },
      { status: 400 }
    );
  }

  try {
    const result = await proposeSourcePath({
      userWallet: user_wallet,
      goal,
      budgetUsdc: Number(budget_usdc),
      routeTier: tier,
    });

    if (result.error && !result.sourcePathId) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const path = (result.verifiedSources as Record<string, unknown>[] || []).map((v, i) => {
      const selected = (result.selectedSources as Record<string, unknown>[] || []).find(
        (s) => s.feed_item_id === v.feed_item_id
      );
      return {
        id: v.feed_item_id,
        order_index: i,
        source_ok: v.source_ok,
        route_ok: v.route_ok,
        verification_reason: v.verification_reason,
        price_usdc: selected?.price_usdc || 0,
        reason: selected?.reason || "",
        title: selected?.title || "",
      };
    });

    return NextResponse.json({
      source_path_id: result.sourcePathId,
      source_path_status: result.sourcePathStatus,
      goal,
      budget_usdc,
      route_tier: result.routeTier,
      route_config: result.routeConfig,
      path,
      total_usdc: result.estimatedTotalUsdc || 0,
      remaining_usdc: result.remainingUsdc || 0,
      rejected: result.rejectedSources || [],
      agent_service_calls: result.agentServiceCalls || [],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
