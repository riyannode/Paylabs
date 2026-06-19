// POST /api/paylabs/tutor/propose
// Compatibility wrapper — redirects to /api/paylabs/learning-paths/propose
// Uses the same LangGraph proposeLearningPath graph.
// Accepts route_tier: normal (default), advanced, premium.
//
// When PAYLABS_ROUTE_TOLL_ENABLED=true, requires route toll proof in headers.

import { NextRequest, NextResponse } from "next/server";
import { proposeLearningPath } from "@/lib/ai-tutor/graph";
import { isValidRouteTier } from "@/lib/ai-tutor/route-config";
import { verifyRouteTollProof } from "@/lib/ai-tutor/route-toll-verify";

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

  // Validate route_tier — reject unknown values
  const tier = route_tier || "normal";
  if (!isValidRouteTier(tier)) {
    return NextResponse.json(
      { error: `Invalid route_tier: "${tier}". Must be normal, advanced, or premium.` },
      { status: 400 }
    );
  }

  // ─── Route toll proof validation ──────────────────────────────
  const tollEnabled = process.env.PAYLABS_ROUTE_TOLL_ENABLED === "true";
  if (tollEnabled) {
    const verifyResult = await verifyRouteTollProof(
      {
        routePaymentId: req.headers.get("x-route-payment-id") || "",
        routePaymentRef: req.headers.get("x-route-payment-ref"),
        routeSettlementRef: req.headers.get("x-route-settlement-ref"),
        routeInputHash: req.headers.get("x-route-input-hash") || "",
      },
      user_wallet,
      tier,
      goal
    );

    if (!verifyResult.ok) {
      return NextResponse.json(
        { error: verifyResult.error },
        { status: verifyResult.status || 403 }
      );
    }
  }

  try {
    const result = await proposeLearningPath({
      userWallet: user_wallet,
      goal,
      budgetUsdc: Number(budget_usdc),
      routeTier: tier,
    });

    if (result.error && !result.pathId) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // ── RSSHub source path response ──
    const verifiedFeed = result.verifiedFeedItems as Record<string, unknown>[] | undefined;
    if (verifiedFeed && verifiedFeed.length > 0) {
      const selectedFeed = (result.selectedFeedItems || []) as Record<string, unknown>[];
      const rejectedFeed = (result.rejectedFeedItems || []) as Record<string, unknown>[];

      const sourcePathItems = verifiedFeed.map((v, i) => {
        const selected = selectedFeed.find(
          (s) => s.feed_item_id === v.feed_item_id
        );
        return {
          id: v.feed_item_id,
          feed_item_id: v.feed_item_id,
          order_index: i,
          title: selected?.source_title || "",
          source_url: selected?.source_url || "",
          creator_wallet: selected?.creator_wallet || "",
          citation_price_usdc: selected?.citation_price_usdc || 0,
          unlock_price_usdc: selected?.unlock_price_usdc || 0,
          reason: selected?.reason || "",
          expected_value: selected?.expected_value || "",
          verification_reason: v.verification_reason || "",
          hash_status: v.hash_status || "verified",
        };
      });

      return NextResponse.json({
        path_id: result.pathId,
        path_status: result.pathStatus,
        path_type: "rsshub_source_path",
        goal,
        budget_usdc,
        route_tier: result.routeTier,
        route_config: result.routeConfig,
        source_path_items: sourcePathItems,
        total_usdc: result.sourcePathTotalUsdc || 0,
        remaining_usdc: result.remainingUsdc || 0,
        rejected: rejectedFeed,
        agent_service_calls: result.agentServiceCalls || [],
      });
    }

    // ── Legacy lesson path response ──
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
      path_type: "legacy_lesson_path",
      goal,
      budget_usdc,
      route_tier: result.routeTier,
      route_config: result.routeConfig,
      path,
      total_usdc: result.estimatedTotalUsdc || 0,
      remaining_usdc: result.remainingUsdc || 0,
      rejected: result.rejectedLessons || [],
      agent_service_calls: result.agentServiceCalls || [],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
