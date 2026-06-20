// POST /api/paylabs/source-paths/propose
//
// Propose a source path using the 15-agent LangGraph workflow.
// RSSHub-first: picks from paylabs_feed_items with monetization gate.
//
// Case A: eligible monetized sources > 0 → full 15-agent paid path
// Case B: eligible monetized = 0, active feeds exist → discovery-only
//
// Flow: tutor_intake → intent_classifier → query_expander → feed_discovery →
// source_ranker → evidence_allocator → stop_limit_controller → budget_optimizer →
// source_quality_verifier → provenance_verifier → creator_ownership_verifier → persist

export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { proposeSourcePath, discoverOnly } from "@/lib/ai-tutor/graph";
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

    // Case B: no monetized sources — run discovery-only flow
    if (result.error && !result.sourcePathId) {
      const noSourceErrors = [
        "No verified monetized sources available",
        "Cannot persist: no verified sources",
      ];
      const isNoSource = noSourceErrors.some(
        (e) => result.error?.startsWith(e)
      );

      if (isNoSource) {
        // Discovery-only: find unclaimed but relevant sources
        const discovery = await discoverOnly({
          userWallet: user_wallet,
          goal,
          routeTier: tier,
        });

        if (discovery.status === "failed") {
          return NextResponse.json(
            {
              error: discovery.error || "Discovery failed",
              code: "DISCOVERY_FAILED",
              eligible_source_count: discovery.eligibleSourceCount,
              source_path_status: "none",
            },
            { status: 500 }
          );
        }

        return NextResponse.json(
          {
            status: "discovery_only",
            paid_path_available: false,
            payment_kind: "discovery_fee",
            eligible_source_count: discovery.eligibleSourceCount,
            unclaimed_source_count: discovery.unclaimedSourceCount,
            discovery_run_id: discovery.discoveryRunId,
            message: "PayLabs charges a discovery fee for AI-powered source routing. Creator payouts begin after ownership is verified.",
            unclaimed_sources: discovery.unclaimedSources,
          },
          { status: 200 }
        );
      }

      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Case A: paid path available — existing flow
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
        evidence_score: selected?.evidence_score || null,
        marginal_value_score: selected?.marginal_value_score || null,
        reason: selected?.reason || "",
        expected_value: selected?.expected_value || "",
      };
    });

    const selectedSources = (result.selectedSources as Record<string, unknown>[] || []).map(s => ({
      feed_item_id: s.feed_item_id,
      evidence_score: s.evidence_score,
      marginal_value_score: s.marginal_value_score,
      reason: s.reason,
    }));

    const excludedSources = (result.excludedSources as Record<string, unknown>[] || []).map(s => ({
      feed_item_id: s.feed_item_id,
      reason: s.reason,
    }));

    return NextResponse.json({
      source_path_id: result.sourcePathId,
      source_path_status: result.sourcePathStatus,
      goal,
      budget_usdc: Number(budget_usdc),
      effective_spend_cap_usdc: result.effectiveSpendCapUsdc || 0,
      route_tier: result.routeTier,
      route_config: result.routeConfig,
      route_limits: result.routeLimits,
      path,
      selected_sources: selectedSources,
      excluded_sources: excludedSources,
      stop_reason: result.stopReason || null,
      stop_limit_hit: result.stopLimitHit || false,
      total_usdc: result.estimatedTotalUsdc || 0,
      creator_payout_usdc: result.estimatedCreatorPayoutUsdc || 0,
      agent_fee_usdc: result.estimatedAgentFeeUsdc || 0,
      treasury_fee_usdc: result.estimatedTreasuryFeeUsdc || 0,
      remaining_usdc: result.remainingUsdc || 0,
      agent_trace: result.agentTrace || {},
      agent_service_calls: result.agentServiceCalls || [],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
