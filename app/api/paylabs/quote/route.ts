/**
 * POST /api/paylabs/quote
 *
 * Get a deterministic price quote for a delegated runtime run.
 * No LLM, no wallet, no network — pure math from tier + budget + limits.
 *
 * Body: { route_tier?, budget_usdc?, wallet_type? }
 * Returns: { ok, requested_route_tier, quote_route_tier, plannedCostUsdc, ... }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  quoteDelegatedRun,
  type DelegatedRouteTier,
  TIER_SERVICE_PRESETS,
  FIXED_FEES_USDC,
} from "@/lib/paylabs/delegated-runtime/quote-engine";

const VALID_TIERS = new Set(["easy", "normal", "advanced", "auto"]);

function resolveTier(raw: unknown): DelegatedRouteTier {
  const t = typeof raw === "string" ? raw.toLowerCase() : "auto";
  if (t === "easy" || t === "normal" || t === "advanced") return t;
  // "auto" → quote the maximum (advanced) to be conservative
  return "advanced";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedTier = typeof body.route_tier === "string" ? body.route_tier : "auto";
    const budgetUsdc = typeof body.budget_usdc === "number" ? body.budget_usdc : 0.01;

    if (budgetUsdc <= 0) {
      return NextResponse.json({ ok: false, error: "budget_usdc must be > 0" }, { status: 400 });
    }

    const resolvedTier = resolveTier(requestedTier);

    // For auto tier: quote advanced (max) conservatively
    const quote = quoteDelegatedRun({
      routeTier: resolvedTier,
      userBudgetUsdc: budgetUsdc,
    });

    // Also compute quotes for all tiers so frontend can show comparison
    const tierQuotes: Record<string, { plannedCostUsdc: number; edges: number }> = {};
    for (const tier of ["easy", "normal", "advanced"] as DelegatedRouteTier[]) {
      const q = quoteDelegatedRun({ routeTier: tier, userBudgetUsdc: budgetUsdc });
      tierQuotes[tier] = {
        plannedCostUsdc: q.plannedCostUsdc,
        edges: q.expectedPaymentEdges,
      };
    }

    return NextResponse.json({
      ok: true,
      requested_route_tier: requestedTier,
      quote_route_tier: resolvedTier,
      plannedCostUsdc: quote.plannedCostUsdc,
      expectedPaymentEdges: quote.expectedPaymentEdges,
      budgetStatus: quote.budgetStatus,
      userBudgetUsdc: quote.userBudgetUsdc,
      remainingPlannedBudgetUsdc: quote.remainingPlannedBudgetUsdc,
      costBreakdown: {
        brainTreasury: FIXED_FEES_USDC.brainTreasury,
        macroNodes: quote.macroNodeFeesUsdc,
        serviceEdges: quote.serviceEdgeFeesUsdc,
        registryChecks: quote.registryCheckFeesUsdc,
        sourceAccesses: quote.sourceAccessFeesUsdc,
        executionFeeUsdc: quote.executionFeeUsdc,
        plannedCreatorPoolUsdc: quote.plannedCreatorPoolUsdc,
        totalPlannedCostUsdc: quote.totalPlannedCostUsdc,
        creatorPayoutLimit: quote.creatorPayoutLimit,
      },
      tierQuotes,
      locked: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
