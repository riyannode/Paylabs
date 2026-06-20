// POST /api/paylabs/discovery-runs/pay
//
// Skeleton for discovery fee payment.
// When flags are false: returns setup_required, no real funds move.
// When flags are true: real Gateway/x402 settlement (future PR).

import { NextRequest, NextResponse } from "next/server";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import { isValidExternalTier, DEFAULT_EXTERNAL_TIER, getDiscoveryFeeTier } from "@/lib/paylabs/route-tier";
import { createNanopaymentRows, createBatchSettlement } from "@/lib/paylabs/nanopayment-service";
import { resolveTreasuryWallet } from "@/lib/paylabs/agent-registry";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { discovery_run_id, user_wallet } = body;
  const rawTier = (body.route_tier || DEFAULT_EXTERNAL_TIER).toLowerCase();
  const routeTier = isValidExternalTier(rawTier) ? rawTier : DEFAULT_EXTERNAL_TIER;

  if (!discovery_run_id) {
    return NextResponse.json(
      { error: "discovery_run_id required" },
      { status: 400 }
    );
  }

  if (!user_wallet || !user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  const flags = getPaymentFlags();
  const feeTier = getDiscoveryFeeTier(routeTier);
  const treasury = resolveTreasuryWallet();

  // ── Create 7 nanopayment rows (always, for audit trail) ──────
  const nanoResult = await createNanopaymentRows({
    discoveryRunId: discovery_run_id,
    userWallet: user_wallet,
    routeTier,
  });

  if (nanoResult.error) {
    return NextResponse.json(
      { error: nanoResult.error },
      { status: 500 }
    );
  }

  // ── Create batch settlement record ───────────────────────────
  const batchResult = await createBatchSettlement({
    discoveryRunId: discovery_run_id,
    routeTier,
  });

  // ── Payment execution ────────────────────────────────────────
  if (!flags.discoveryFeeEnabled) {
    // Flags false: no real payment, return planned state
    return NextResponse.json({
      status: "planned",
      message: "Discovery fee payment is disabled. Rows created for audit trail.",
      route_tier: routeTier,
      amount_usdc: feeTier.userPaysUsdc,
      agent_nanopayments: nanoResult.rows.length,
      settlement_mode: feeTier.settlementMode,
      treasury_wallet: treasury.address || "not_configured",
      payment_route: flags.paymentRoute,
      receipt_ids: nanoResult.rows.map((r) => r.receipt_id),
      batch_settlement_id: batchResult.row?.id || null,
    });
  }

  // Flags true but real settlement not yet implemented:
  // Return setup_required — do NOT fake payment refs.
  return NextResponse.json({
    status: "setup_required",
    message: "Discovery fee payment is enabled but real Circle Gateway settlement is not yet implemented in this PR. Follow-up PR will wire real x402 settlement.",
    route_tier: routeTier,
    amount_usdc: feeTier.userPaysUsdc,
    agent_nanopayments: nanoResult.rows.length,
    settlement_mode: feeTier.settlementMode,
    treasury_wallet: treasury.address || "not_configured",
    payment_route: flags.paymentRoute,
    receipt_ids: nanoResult.rows.map((r) => r.receipt_id),
    batch_settlement_id: batchResult.row?.id || null,
  });
}
