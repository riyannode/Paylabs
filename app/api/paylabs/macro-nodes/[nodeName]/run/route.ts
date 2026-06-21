/**
 * Macro-Node x402 Seller Endpoint
 *
 * POST /api/paylabs/macro-nodes/[nodeName]/run
 *
 * Payment graph: Brain → macro-node → child services
 *
 * DUAL MODE:
 * - x402 enabled: 402 challenge → verify → settle → execute macro-node runner
 * - audit-only: execute macro-node runner directly
 *
 * After settlement, the macro-node runner executes its child services.
 * Child services are paid by the macro-node's buyer wallet (not Brain's).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getMacroNodeConfig,
  isValidMacroNodeName,
  resolveNodeSellerWallet,
  resolveNodeBuyerWalletId,
} from "@/lib/paylabs/delegated-runtime/node-registry";
import {
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
  type X402ChallengeRequirements,
} from "@/lib/paylabs/x402/seller-challenge";
import { isDelegatedRuntimeEnabled } from "@/lib/paylabs/feature-flags";
import { createOrchestratorState, addProgressSummary } from "@/lib/paylabs/delegated-runtime/state";
import { runDiscoveryPlanner } from "@/lib/paylabs/delegated-runtime/macro-nodes/discovery-planner";
import { runPaymentDecision } from "@/lib/paylabs/delegated-runtime/macro-nodes/payment-decision";
import { runSettlementMemory } from "@/lib/paylabs/delegated-runtime/macro-nodes/settlement-memory";
import type { MacroNodePhase, OrchestratorInput } from "@/lib/paylabs/delegated-runtime/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ nodeName: string }> }
) {
  if (!isDelegatedRuntimeEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Delegated runtime is not enabled" },
      { status: 403 }
    );
  }

  const { nodeName } = await params;

  if (!isValidMacroNodeName(nodeName)) {
    return NextResponse.json(
      { ok: false, error: `Invalid macro-node name: ${nodeName}` },
      { status: 400 }
    );
  }

  const nodeConfig = getMacroNodeConfig(nodeName as MacroNodePhase);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { discoveryRunId, userGoal, routeTier, userBudgetUsdc, userWallet, payload } = body as {
    discoveryRunId?: string;
    userGoal?: string;
    routeTier?: string;
    userBudgetUsdc?: number;
    userWallet?: string;
    payload?: Record<string, unknown>;
  };

  // Payload from upstream (Brain/previous macro-node) for data forwarding
  const nodePayload: Record<string, unknown> = payload || {};

  if (!discoveryRunId || !userGoal || !routeTier) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: discoveryRunId, userGoal, routeTier" },
      { status: 400 }
    );
  }

  const x402Enabled = !!process.env[`PAYLABS_NODE_X402_ENABLED`];

  if (!x402Enabled) {
    return executeMacroNode(nodeName as MacroNodePhase, {
      discoveryRunId,
      userGoal,
      userWallet: userWallet || "",
      userBudgetUsdc: userBudgetUsdc || 0,
      routeTier: routeTier as OrchestratorInput["routeTier"],
    }, null, nodePayload);
  }

  // ── x402 path ──
  let sellerAddress: string;
  try {
    sellerAddress = resolveNodeSellerWallet(nodeConfig);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const paymentHeader =
    req.headers.get("payment-signature") ??
    req.headers.get("PAYMENT-SIGNATURE") ??
    req.headers.get("x-payment") ??
    req.headers.get("X-Payment");

  const amountAtomic = Math.round(nodeConfig.fixedNodeFeeUsdc * 1_000_000).toString();

  if (!paymentHeader) {
    const challenge = buildX402Challenge(sellerAddress, amountAtomic, req.url);
    const encoded = encodeChallengeHeader(challenge);
    const response = NextResponse.json(
      { ok: false, error: "Payment required", x402: true, node: nodeName, amount_usdc: nodeConfig.fixedNodeFeeUsdc.toString() },
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
    maxTimeoutSeconds: 604900,
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

  return executeMacroNode(nodeName as MacroNodePhase, {
    discoveryRunId,
    userGoal,
    userWallet: userWallet || "",
    userBudgetUsdc: userBudgetUsdc || 0,
    routeTier: routeTier as OrchestratorInput["routeTier"],
  }, (settleResult.paymentMeta as Record<string, unknown>) ?? null, nodePayload);
}

// ─── Execute Macro-Node Runner ───────────────────────────────

async function executeMacroNode(
  nodeName: MacroNodePhase,
  input: OrchestratorInput,
  paymentMeta: Record<string, unknown> | null,
  payload?: Record<string, unknown>,
) {
  const nodeConfig = getMacroNodeConfig(nodeName);
  const state = createOrchestratorState(input);

  // Resolve this node's buyer wallet ID — child services use it
  let parentWalletId: string | undefined;
  try {
    parentWalletId = resolveNodeBuyerWalletId(nodeConfig);
  } catch {
    // audit-only: no wallet needed
  }

  const selectedServices = nodeConfig.childServices;
  const opts = { selectedServices, parentWalletId };

  try {
    let result: unknown;

    if (nodeName === "discovery_planner") {
      result = await runDiscoveryPlanner(state, opts);
    } else if (nodeName === "payment_decision") {
      // Payload from upstream: { ranked_candidates } from discovery_planner
      const candidates = (payload?.ranked_candidates || []) as Parameters<typeof runPaymentDecision>[1];
      result = await runPaymentDecision(state, candidates, opts);
    } else if (nodeName === "settlement_memory") {
      // Payload from upstream: { approved_items } from payment_decision
      const approvedItems = (payload?.approved_items || []) as Parameters<typeof runSettlementMemory>[1];
      result = await runSettlementMemory(state, approvedItems, opts);
    }

    return NextResponse.json({
      ok: true,
      nodeType: "macro_node",
      nodeName,
      mode: paymentMeta ? "x402" : "audit_only",
      settled: !!paymentMeta,
      safeSummary: `Macro-node ${nodeName}: ${selectedServices.length} child services`,
      data: result,
      childServices: selectedServices,
      paymentMeta,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, nodeType: "macro_node", nodeName, error: msg },
      { status: 500 }
    );
  }
}
