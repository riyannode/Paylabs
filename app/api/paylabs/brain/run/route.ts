/**
 * Brain x402 Seller Endpoint
 *
 * POST /api/paylabs/brain/run
 *
 * Payment graph: run_budget_controller → Brain
 *
 * DUAL MODE:
 * - x402 enabled: returns 402 challenge, verifies/settles, then returns Brain data
 * - audit-only: returns Brain data directly (settled=false)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getBrainConfig,
  resolveNodeSellerWallet,
} from "@/lib/paylabs/delegated-runtime/node-registry";
import {
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
  type X402ChallengeRequirements,
} from "@/lib/paylabs/x402/seller-challenge";
import { isDelegatedRuntimeEnabled } from "@/lib/paylabs/feature-flags";

export async function POST(req: NextRequest) {
  if (!isDelegatedRuntimeEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Delegated runtime is not enabled" },
      { status: 403 }
    );
  }

  const brainConfig = getBrainConfig();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { userGoal, routeTier, userBudgetUsdc, discoveryRunId } = body as {
    userGoal?: string;
    routeTier?: string;
    userBudgetUsdc?: number;
    discoveryRunId?: string;
  };

  if (!userGoal || !routeTier || !discoveryRunId) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: userGoal, routeTier, discoveryRunId" },
      { status: 400 }
    );
  }

  const x402Enabled = process.env.PAYLABS_BRAIN_X402_ENABLED === "true";

  if (!x402Enabled) {
    return NextResponse.json({
      ok: true,
      nodeType: "brain",
      mode: "audit_only",
      settled: false,
      safeSummary: "Brain: audit-only (x402 not enabled)",
      data: { userGoal, routeTier, userBudgetUsdc, discoveryRunId },
    });
  }

  // ── x402 path ──
  let sellerAddress: string;
  try {
    sellerAddress = resolveNodeSellerWallet(brainConfig);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const paymentHeader =
    req.headers.get("payment-signature") ??
    req.headers.get("PAYMENT-SIGNATURE") ??
    req.headers.get("x-payment") ??
    req.headers.get("X-Payment");

  const amountAtomic = Math.round(brainConfig.fixedBrainFeeUsdc * 1_000_000).toString();

  if (!paymentHeader) {
    const challenge = buildX402Challenge(sellerAddress, amountAtomic, req.url);
    const encoded = encodeChallengeHeader(challenge);
    const response = NextResponse.json(
      { ok: false, error: "Payment required", x402: true, node: "brain", amount_usdc: brainConfig.fixedBrainFeeUsdc.toString() },
      { status: 402 }
    );
    response.headers.set("PAYMENT-REQUIRED", encoded);
    return response;
  }

  const requirements: X402ChallengeRequirements = {
    scheme: "exact",
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: amountAtomic,
    payTo: sellerAddress,
    maxTimeoutSeconds: 604800,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };

  const settleResult = await verifyAndSettlePayment(paymentHeader, requirements);

  if (!settleResult.ok || !settleResult.settled) {
    return NextResponse.json(
      { ok: false, error: settleResult.error || "Payment failed", settled: false },
      { status: 402 }
    );
  }

  return NextResponse.json({
    ok: true,
    nodeType: "brain",
    mode: "x402",
    settled: true,
    safeSummary: `Brain x402 settled: ${amountAtomic} atomic`,
    data: { userGoal, routeTier, userBudgetUsdc, discoveryRunId },
    paymentMeta: settleResult.paymentMeta,
  });
}
