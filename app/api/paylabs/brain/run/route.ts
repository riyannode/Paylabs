/**
 * Brain x402 Seller Endpoint
 *
 * POST /api/paylabs/brain/run
 *
 * Payment graph: run_budget_controller → Brain
 *
 * x402-ONLY (fail-closed):
 * - x402 enabled: returns 402 challenge, verifies/settles, then runs Brain LLM
 * - x402 disabled: returns 500 config_error. Brain NEVER executes without payment.
 *
 * After x402 settlement, calls runBrainPlannerGraph() and returns full Brain
 * planning output including brainPlanning, brainLlmDiag, selected nodes/services,
 * planned cost, and safe summaries.
 *
 * Brain ONLY plans — it does NOT execute service payments or pull user balance.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getBrainConfig,
  resolveNodeSellerWallet,
} from "@/lib/paylabs/delegated-runtime/node-registry";
import {
  buildPaymentRequirements,
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
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

  const { userGoal, routeTier, userBudgetUsdc, discoveryRunId, userWallet } = body as {
    userGoal?: string;
    routeTier?: string;
    userBudgetUsdc?: number;
    discoveryRunId?: string;
    userWallet?: string;
  };

  if (!userGoal || !routeTier || !discoveryRunId) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: userGoal, routeTier, discoveryRunId" },
      { status: 400 }
    );
  }

  if (process.env.PAYLABS_BRAIN_X402_ENABLED !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "config_error: PAYLABS_BRAIN_X402_ENABLED must be true. Brain is x402-only.",
      },
      { status: 500 }
    );
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

  const requirements = buildPaymentRequirements(sellerAddress, amountAtomic);

  const settleResult = await verifyAndSettlePayment(paymentHeader, requirements);

  if (!settleResult.ok || !settleResult.settled) {
    return NextResponse.json(
      { ok: false, error: settleResult.error || "Payment failed", settled: false },
      { status: 402 }
    );
  }

  // ── x402 settled — now run Brain LLM planner ──
  const { runBrainPlannerGraph } = await import("@/lib/paylabs/langgraph/brain/brain-planner-graph");

  let brainResult;
  try {
    brainResult = await runBrainPlannerGraph({
      discoveryRunId,
      userGoal,
      routeTier: routeTier as import("@/lib/paylabs/delegated-runtime/types").DelegatedRouteTier,
      userBudgetUsdc: userBudgetUsdc ?? 0.01,
      userWallet: userWallet || "",
    });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    console.error("[brain/run] runBrainPlannerGraph failed after x402 settle", { error: errMsg });
    return NextResponse.json({
      ok: false,
      nodeType: "brain",
      mode: "x402",
      settled: true,
      error: `Brain LLM failed after payment: ${errMsg}`,
      paymentMeta: settleResult.paymentMeta,
    });
  }

  // ── Build safe response from Brain planner output ──
  const bp = brainResult.brainPlanning;

  return NextResponse.json({
    ok: brainResult.ok,
    nodeType: "brain",
    mode: "x402",
    settled: true,
    // Full Brain planning output — source of truth for downstream
    brainPlanning: bp
      ? {
          normalized_goal: bp.normalized_goal,
          route_tier_hint: bp.route_tier_hint,
          discovery_strategy: bp.discovery_strategy,
          suggested_query_variants: bp.suggested_query_variants,
          service_execution_plan: bp.service_execution_plan,
          safe_brain_summary: bp.safe_brain_summary,
          assistant_response: bp.assistant_response,
          user_visible_reasoning: bp.user_visible_reasoning,
          tier_decision_reason: bp.tier_decision_reason,
          plan_rationale: bp.plan_rationale,
          selected_macro_nodes: bp.selected_macro_nodes,
          selected_services: bp.selected_services,
          max_registry_checks: bp.max_registry_checks,
          max_source_accesses: bp.max_source_accesses,
          planned_cost_usdc: bp.planned_cost_usdc,
          planned_cost_breakdown: bp.planned_cost_breakdown,
        }
      : null,
    brainLlmDiag: brainResult.brainLlmDiag ?? null,
    selectedMacroNodes: brainResult.selectedMacroNodes,
    selectedServices: brainResult.selectedServices,
    plannedCostUsdc: brainResult.plannedCostUsdc,
    finalSummary: brainResult.finalSummary,
    progressSummaries: brainResult.progressSummaries,
    error: brainResult.error,
    data: { userGoal, routeTier, userBudgetUsdc, discoveryRunId },
    paymentMeta: settleResult.paymentMeta,
  });
}
