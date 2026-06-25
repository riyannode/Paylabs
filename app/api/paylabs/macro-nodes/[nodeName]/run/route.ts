/**
 * Macro-Node x402 Seller Endpoint
 *
 * POST /api/paylabs/macro-nodes/[nodeName]/run
 *
 * Payment graph: Brain → macro-node → child services
 *
 * x402-ONLY (fail-closed):
 * - x402 enabled: 402 challenge → verify → settle → execute macro-node graph
 * - x402 disabled: returns 500 config_error. Macro-node NEVER executes without payment.
 *
 * After settlement, the macro-node LangGraph executes its child services.
 * Child services are paid by the macro-node's buyer wallet (not Brain's).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getMacroNodeConfig,
  isValidMacroNodeName,
  resolveNodeSellerWallet,
  resolveNodeBuyerWalletId,
  getMacroNodeAllocationUsdc,
} from "@/lib/paylabs/delegated-runtime/node-registry";
import {
  buildPaymentRequirements,
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
} from "@/lib/paylabs/x402/seller-challenge";
import { isDelegatedRuntimeEnabled } from "@/lib/paylabs/feature-flags";
import { TIER_SERVICE_PRESETS } from "@/lib/paylabs/delegated-runtime/quote-engine";
import { createOrchestratorState, addProgressSummary, addServiceEvaluation } from "@/lib/paylabs/delegated-runtime/state";
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

  const nodePayload: Record<string, unknown> = payload || {};

  if (!discoveryRunId || !userGoal || !routeTier) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: discoveryRunId, userGoal, routeTier" },
      { status: 400 }
    );
  }

  if (process.env.PAYLABS_NODE_X402_ENABLED !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "config_error: PAYLABS_NODE_X402_ENABLED must be true. Macro nodes are x402-only.",
      },
      { status: 500 }
    );
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

  // Use full macro allocation (base fee + child budget), not just base fee
  const macroAllocationUsdc = getMacroNodeAllocationUsdc(nodeName as MacroNodePhase);
  const amountAtomic = Math.round(macroAllocationUsdc * 1_000_000).toString();

  if (!paymentHeader) {
    const challenge = buildX402Challenge(sellerAddress, amountAtomic, req.url);
    const encoded = encodeChallengeHeader(challenge);
    const response = NextResponse.json(
      { ok: false, error: "Payment required", x402: true, node: nodeName, amount_usdc: macroAllocationUsdc.toString() },
      { status: 402 }
    );
    response.headers.set("PAYMENT-REQUIRED", encoded);
    return response;
  }

  const requirements = buildPaymentRequirements(sellerAddress, amountAtomic);

  const settleResult = await verifyAndSettlePayment(paymentHeader, requirements);

  if (!settleResult.ok || !settleResult.settled) {
    return NextResponse.json(
      { ok: false, error: settleResult.error || "Payment failed", settled: false },
      { status: 402 }
    );
  }

  // Inject DCW signer for child service x402 payments
  const { setDcwSigner, getDcwSigner, createDcwSigner } = await import("@/lib/paylabs/x402/dcw-signer-adapter");
  if (!getDcwSigner()) {
    setDcwSigner(createDcwSigner());
  }

  return executeMacroNode(nodeName as MacroNodePhase, {
    discoveryRunId,
    userGoal,
    userWallet: userWallet || "",
    userBudgetUsdc: userBudgetUsdc || 0,
    routeTier: routeTier as OrchestratorInput["routeTier"],
  }, (settleResult.paymentMeta as Record<string, unknown>) ?? null, nodePayload);
}

// ─── Execute Macro-Node via LangGraph ────────────────────────

async function executeMacroNode(
  nodeName: MacroNodePhase,
  input: OrchestratorInput,
  paymentMeta: Record<string, unknown> | null,
  payload?: Record<string, unknown>,
) {
  const nodeConfig = getMacroNodeConfig(nodeName);
  const state = createOrchestratorState(input);

  let parentWalletId: string;
  try {
    parentWalletId = resolveNodeBuyerWalletId(nodeConfig);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }

  // Use tier-based service selection for discovery_planner, static for others
  const selectedServices = nodeName === "discovery_planner"
    ? TIER_SERVICE_PRESETS[input.routeTier as keyof typeof TIER_SERVICE_PRESETS] || nodeConfig.childServices
    : nodeConfig.childServices;

  try {
    let result: unknown;

    if (nodeName === "discovery_planner") {
      const { runDiscoveryPlannerGraph } = await import("@/lib/paylabs/langgraph/macro-nodes/discovery-planner-graph");
      const graphResult = await runDiscoveryPlannerGraph({
        discoveryRunId: input.discoveryRunId,
        userGoal: input.userGoal,
        routeTier: input.routeTier,
        userBudgetUsdc: input.userBudgetUsdc,
        selectedServices,
        parentWalletId,
        // V3: Brain pass-through for better query expansion
        brainNormalizedGoal: typeof payload?.brain_normalized_goal === "string" ? payload.brain_normalized_goal : undefined,
        brainDiscoveryStrategy: typeof payload?.brain_discovery_strategy === "string" ? payload.brain_discovery_strategy : undefined,
        brainSuggestedQueryVariants: Array.isArray(payload?.brain_suggested_query_variants) ? payload.brain_suggested_query_variants as string[] : undefined,
        brainSafeSummary: typeof payload?.brain_safe_summary === "string" ? payload.brain_safe_summary : undefined,
      });
      for (const ev of graphResult.serviceEvaluations) {
        addServiceEvaluation(state, ev);
      }
      for (const pe of graphResult.paymentEdges) {
        state.paymentEdges.push(pe);
      }
      result = { ok: graphResult.ok, rankedCandidates: graphResult.rankedCandidates, easySummary: graphResult.easySummary };

    } else if (nodeName === "payment_decision") {
      const { runPaymentDecisionGraph } = await import("@/lib/paylabs/langgraph/macro-nodes/payment-decision-graph");
      const rankedCandidates = (payload?.ranked_candidates || []) as Array<{
        feed_item_id: string; source_url?: string; title: string; publisher: string; rank: number; relevance_score: number;
      }>;
      // Convert ranked_candidates to SafeSourceCard format
      const sourceCards = rankedCandidates.map((c) => ({
        feed_item_id: c.feed_item_id,
        title: c.title || "",
        source_url: c.source_url || "",
        publisher: c.publisher || "",
        claim_status: "unclaimed",
        creator_wallet: null,
        source_kind: (c as Record<string, unknown>).source_kind as string | undefined,
        provider: (c as Record<string, unknown>).provider as string | undefined,
      }));
      const graphResult = await runPaymentDecisionGraph({
        discoveryRunId: input.discoveryRunId,
        userGoal: input.userGoal,
        routeTier: input.routeTier,
        userBudgetUsdc: input.userBudgetUsdc,
        sourceCards,
        selectedServices,
        parentWalletId,
      });
      for (const ev of graphResult.serviceEvaluations) {
        addServiceEvaluation(state, ev);
      }
      for (const pe of graphResult.paymentEdges) {
        state.paymentEdges.push(pe);
      }
      result = { ok: graphResult.ok, approvedItems: graphResult.approvedItems, skippedItems: graphResult.skippedItems, normalSummary: graphResult.normalSummary };

    } else if (nodeName === "settlement_memory") {
      const { runSettlementMemoryGraph } = await import("@/lib/paylabs/langgraph/macro-nodes/settlement-memory-graph");
      const approvedItems = (payload?.approved_items || []) as Array<{
        feed_item_id: string; source_url: string; source_title: string; approved_price_usdc: number; final_score: number; risk_score: number; creator_wallet: string | null;
      }>;
      const graphResult = await runSettlementMemoryGraph({
        discoveryRunId: input.discoveryRunId,
        userGoal: input.userGoal,
        routeTier: input.routeTier,
        userBudgetUsdc: input.userBudgetUsdc,
        approvedItems,
        selectedServices,
        parentWalletId,
      });
      for (const ev of graphResult.serviceEvaluations) {
        addServiceEvaluation(state, ev);
      }
      for (const pe of graphResult.paymentEdges) {
        state.paymentEdges.push(pe);
      }
      result = { ok: graphResult.ok, routedItems: graphResult.routedItems, failedItems: graphResult.failedItems, advancedSummary: graphResult.advancedSummary };
    }

    return NextResponse.json({
      ok: true,
      nodeType: "macro_node",
      nodeName,
      mode: "x402",
      settled: !!paymentMeta,
      safeSummary: `Macro-node ${nodeName}: ${selectedServices.length} child services`,
      data: result,
      childServices: selectedServices,
      paymentMeta,
      serviceEvaluations: state.serviceEvaluations.map((e) => ({
        serviceName: e.serviceName,
        status: e.status,
        settled: e.settled,
        mode: e.mode,
        costUsdc: e.costUsdc,
        error: e.error ?? null,
        safeSummary: e.safeSummary,
        txHash: e.paymentMeta?.txHash ?? null,
        explorerUrl: e.paymentMeta?.explorerUrl ?? null,
      })),
      paymentEdges: state.paymentEdges.map((e) => ({
        buyer: e.buyerServiceName,
        seller: e.sellerServiceName,
        amountUsdc: e.amountUsdc,
        status: e.status,
        layer: e.layer ?? null,
        accountingRole: e.accountingRole ?? null,
        sourceOfFunds: e.sourceOfFunds ?? null,
        paymentMode: e.paymentMode ?? null,
        paymentRef: e.paymentRef ?? null,
        settlementRef: e.settlementRef ?? null,
        txHash: e.txHash ?? null,
        explorerUrl: e.explorerUrl ?? null,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, nodeType: "macro_node", nodeName, error: msg },
      { status: 500 }
    );
  }
}
