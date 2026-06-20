// POST /api/paylabs/discovery-runs/quote
//
// Returns discovery fee breakdown for a given route tier.
// No payment movement — pure calculation.
//
// External tier: easy | normal | advanced
// Default: easy

import { NextRequest, NextResponse } from "next/server";
import { PAID_AGENTS, AGENT_NANOPRICE_USDC, AGENT_COUNT } from "@/lib/paylabs/agent-registry";
import { getDiscoveryFeeTier, isValidExternalTier, DEFAULT_EXTERNAL_TIER } from "@/lib/paylabs/route-tier";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const rawTier = (body.route_tier || DEFAULT_EXTERNAL_TIER).toLowerCase();
  const routeTier = isValidExternalTier(rawTier) ? rawTier : DEFAULT_EXTERNAL_TIER;

  const feeTier = getDiscoveryFeeTier(routeTier);

  return NextResponse.json({
    route_tier: feeTier.tier,
    payment_kind: "discovery_fee",
    amount_usdc: feeTier.userPaysUsdc,
    agent_price_usdc: AGENT_NANOPRICE_USDC,
    agent_count: AGENT_COUNT,
    agent_total_usdc: feeTier.agentNanopaymentsUsdc,
    gateway_buffer_usdc: feeTier.gatewayBufferUsdc,
    treasury_fee_usdc: feeTier.treasuryFeeUsdc,
    settlement_mode: feeTier.settlementMode,
    max_source_candidates: feeTier.maxSourceCandidates,
    agents: PAID_AGENTS.map((a) => ({
      name: a.name,
      capability: a.capability,
      price_usdc: AGENT_NANOPRICE_USDC,
    })),
  });
}
