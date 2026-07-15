/**
 * POST /api/paylabs/discovery-runs/execute-locked
 *
 * Execute a full delegated run with a pre-locked plan from route-preflight.
 * Obtains Brain via route-preflight paid Brain seller. Uses locked tier + plan from agent_trace.auto_tier_preflight.
 *
 * Flow:
 *   1st request (no payment) → 402 + final entry payment challenge
 *   2nd request (with payment) → verify+settle → locked macro-node pipeline
 *
 * Gated behind PAYLABS_AUTO_TIER_PREFLIGHT_ENABLED feature flag.
 * Requires a completed route-preflight (agent_trace.auto_tier_preflight.status === "locked").
 *
 * Payment accounting:
 *   User Cost = routing_fee + final_entry_payment (stored as user payment metadata)
 *   Platform x402 Volume = internal macro/service graph (paymentGraph)
 *   Brain x402 payment occurs during route-preflight. Controller→brain edge is prepended from preflight brain_payment metadata.
 */

export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";
import type { DelegatedRouteTier, ExecutionPlan } from "@/lib/paylabs/delegated-runtime/types";
import type { OrchestratorOutput, PaymentGraphEdge } from "@/lib/paylabs/delegated-runtime/types";
import { TIER_PHASE_MAP } from "@/lib/paylabs/delegated-runtime/state";
import { getMacroNodeAllocationUsdcForTier } from "@/lib/paylabs/delegated-runtime/node-registry";
import type { MacroNodePhase } from "@/lib/paylabs/delegated-runtime/types";
import {
  reconstructLockedPlan,
  executeLockedMacroNodePipeline,
} from "@/lib/paylabs/delegated-runtime/locked-orchestration";
import type { X402CallResult } from "@/lib/paylabs/delegated-runtime/locked-orchestration";
import { resolvePaylabsAppUrl, resolvePublicAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import { randomUUID } from "node:crypto";

// ─── Local helpers (same as inline/route.ts) ─────────────────

function resolveAppUrl(): string {
  const { baseUrl } = resolvePaylabsAppUrl();
  return baseUrl;
}

async function callMacroNodeX402(
  dcwSigner: import("@/lib/paylabs/x402/buyer-transport").DcwSigner,
  nodeName: string,
  body: {
    discoveryRunId: string;
    userGoal: string;
    routeTier: string;
    userBudgetUsdc: number;
    userWallet: string;
    payload?: Record<string, unknown>;
  },
): Promise<X402CallResult> {
  const { callPaidSeller } = await import("@/lib/paylabs/x402/buyer-transport");
  const base = resolveAppUrl();
  const result = await callPaidSeller(dcwSigner, {
    sellerUrl: `${base}/api/paylabs/macro-nodes/${nodeName}/run`,
    method: "POST",
    body,
    buyerWalletId: process.env.PAYLABS_BRAIN_BUYER_WALLET_ID || "",
    buyerAgentName: "brain",
    sellerServiceName: nodeName as import("@/lib/paylabs/agent-services/types").ServiceName,
    discoveryRunId: body.discoveryRunId,
    maxAmountUsdc: "0.001",
    requirePayment: true,
  });
  return {
    ok: result.ok,
    data: result.data as Record<string, unknown> | null,
    error: result.error || null,
    paymentMetadata: result.paymentMetadata ?? null,
  };
}

function buildLockedOutput(
  discoveryRunId: string,
  routeTier: DelegatedRouteTier,
  userBudgetUsdc: number,
  status: "completed" | "failed",
  safeProgressSummaries: string[],
  paymentGraph: PaymentGraphEdge[],
  brainData: Record<string, unknown> | null,
  macroNodeResults: Record<string, Record<string, unknown>> | null,
  error: string | null,
  sourceContext?: import("@/lib/paylabs/sources/types").SourceContext,
  lockedPlan?: ExecutionPlan | null,
): OrchestratorOutput {
  const macroNodes = lockedPlan?.selectedMacroNodes
    ?? (TIER_PHASE_MAP[routeTier] || TIER_PHASE_MAP.easy);

  // Build payment plan from payment_decision result
  const paymentResult = macroNodeResults?.["payment_decision"];
  const paymentRunnerData = paymentResult
    ? ((paymentResult.data as Record<string, unknown>) || paymentResult)
    : null;
  const approvedItems = ((paymentRunnerData?.approvedItems as Array<{
    feed_item_id: string; source_url: string; source_title: string;
    approved_price_usdc: number; final_score: number; risk_score: number;
  }>) || (paymentRunnerData?.approved_items as Array<{
    feed_item_id: string; source_url: string; source_title: string;
    approved_price_usdc: number; final_score: number; risk_score: number;
  }>)) || [];
  const paymentPlan = approvedItems.map((item) => ({
    itemId: item.feed_item_id,
    sourceUrl: item.source_url,
    sourceTitle: item.source_title,
    priceUsdc: item.approved_price_usdc,
    approved: true,
    skipReason: null,
    finalScore: item.final_score,
    riskScore: item.risk_score,
  }));

  // Tiered summaries
  const tieredSummaries: import("@/lib/paylabs/delegated-runtime/types").TieredRunSummaries = {
    final_summary: safeProgressSummaries.join(" | "),
  };
  const discoveryResult = macroNodeResults?.["discovery_planner"];
  if (discoveryResult) {
    const d = (discoveryResult.data as Record<string, unknown>) || discoveryResult;
    const candidates = (d.rankedCandidates as unknown[]) || (d.ranked_candidates as unknown[]) || [];
    tieredSummaries.easy_summary = `Discovery: ${candidates.length} candidates found.`;
  }
  if (paymentRunnerData) {
    const approved = (paymentRunnerData.approvedItems as unknown[]) || (paymentRunnerData.approved_items as unknown[]) || [];
    const skipped = (paymentRunnerData.skippedItems as unknown[]) || (paymentRunnerData.skipped_items as unknown[]) || [];
    tieredSummaries.normal_summary = `Payment Decision: ${approved.length} approved, ${skipped.length} skipped.`;
  }
  const settlementResult = macroNodeResults?.["settlement_memory"];
  if (settlementResult) {
    const s = (settlementResult.data as Record<string, unknown>) || settlementResult;
    const routed = (s.routedItems as unknown[]) || (s.routed_items as unknown[]) || [];
    tieredSummaries.advanced_summary = `Settlement: ${routed.length} items routed.`;
  }

  // Compute settled spend from paymentGraph
  const settledSpendUsdc = paymentGraph
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  // User budget spend (controller→brain + brain→macro edges)
  const userBudgetSpendEdges = paymentGraph.filter(
    (e) => e.buyer === "brain" && e.nodeType === "macro_node",
  );
  const userBudgetUsedUsdc = userBudgetSpendEdges
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  // Child payment volume (macro→child edges)
  const childPaymentEdges = paymentGraph.filter((e) => e.nodeType === "service");
  const childPaymentVolumeUsdc = childPaymentEdges
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  // Creator distribution from settlement_memory
  const settlementMemoryResult = macroNodeResults?.["settlement_memory"];
  const settlementMemoryData = settlementMemoryResult
    ? ((settlementMemoryResult.data as Record<string, unknown>) || settlementMemoryResult)
    : null;
  const settlementCreatorDist = settlementMemoryData?.creatorDistribution as Record<string, unknown> | undefined;
  const creatorDistribution: OrchestratorOutput["creatorDistribution"] = settlementCreatorDist
    ? {
        payoutSummary: (settlementCreatorDist.payoutSummary as string) ?? null,
        payoutResults: (settlementCreatorDist.payoutResults as OrchestratorOutput["creatorDistribution"] extends { payoutResults: infer R } ? R : never) ?? [],
        evaluatorOutput: (settlementCreatorDist.evaluatorOutput as Record<string, unknown>) ?? null,
        pendingReserveAtomic: (settlementCreatorDist.pendingReserveAtomic as string) ?? null,
        actualCreatorPaidAtomic: (settlementCreatorDist.actualCreatorPaidAtomic as string) ?? null,
        actualCreatorPaidUsdc: (settlementCreatorDist.actualCreatorPaidUsdc as number) ?? null,
        creatorSplitPlan: (settlementCreatorDist.creatorSplitPlan as Record<string, unknown>) ?? null,
        plannedCreatorPoolAtomic: (settlementCreatorDist.plannedCreatorPoolAtomic as string) ?? null,
        plannedCreatorPayoutCount: (settlementCreatorDist.plannedCreatorPayoutCount as number) ?? null,
        advancedEvaluatorStatus: (settlementCreatorDist.advancedEvaluatorStatus as string) ?? null,
        botShareResult: (settlementCreatorDist.botShareResult as OrchestratorOutput["creatorDistribution"] extends { botShareResult: infer R } ? R : never) ?? null,
        serviceShareResult: (settlementCreatorDist.serviceShareResult as OrchestratorOutput["creatorDistribution"] extends { serviceShareResult: infer R } ? R : never) ?? null,
      }
    : undefined;

  const grossPaymentVolumeUsdc = userBudgetUsedUsdc + childPaymentVolumeUsdc;

  return {
    discoveryRunId,
    status,
    routeTier,
    phasesCompleted: (status === "completed" ? macroNodes : []) as OrchestratorOutput["phasesCompleted"],
    safeProgressSummaries,
    budgetSnapshot: {
      totalBudgetUsdc: userBudgetUsdc,
      spentUsdc: userBudgetUsedUsdc,
      remainingUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      serviceSpend: {} as Record<string, number>,
      settledServiceFeesUsdc: childPaymentVolumeUsdc,
      estimatedServiceFeesUsdc: 0,
      userBudgetUsdc,
      userBudgetUsedUsdc,
      remainingBudgetUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      treasuryFeeUsdc: 0,
      macroAllocationUsdc: userBudgetUsedUsdc, // all spend is brain→macro level
      childPaymentVolumeUsdc,
      grossPaymentVolumeUsdc,
      executionFeeUsdc: lockedPlan
        ? (lockedPlan.plannedCostBreakdown.brain_treasury_usdc +
           lockedPlan.plannedCostBreakdown.macro_node_fees_usdc +
           lockedPlan.plannedCostBreakdown.service_edge_fees_usdc +
           lockedPlan.plannedCostBreakdown.registry_check_fees_usdc +
           lockedPlan.plannedCostBreakdown.source_access_fees_usdc)
        : undefined,
    },
    consensusDecisions: [],
    paymentPlan,
    paymentEdges: [],
    serviceEvaluations: [],
    brainPlanning: brainData ? ({
      ...brainData,
      route_tier_hint: routeTier,
      selected_macro_nodes: lockedPlan?.selectedMacroNodes ?? [],
      selected_services: lockedPlan?.selectedServices ?? [],
      planned_cost_usdc: lockedPlan?.plannedCostUsdc ?? 0,
      planned_cost_breakdown: lockedPlan?.plannedCostBreakdown ?? {
        brain_treasury_usdc: 0,
        macro_node_fees_usdc: 0,
        service_edge_fees_usdc: 0,
        registry_check_fees_usdc: 0,
        source_access_fees_usdc: 0,
      },
    } as OrchestratorOutput["brainPlanning"]) : null,
    paymentGraph,
    tieredSummaries,
    sourceContext,
    creatorDistribution,
    error,
  };
}

// ─── Main Handler ────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Gate: feature flag ────────────────────────────────────
  if (!isAutoTierPreflightEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Execute-locked is not enabled" },
      { status: 404 },
    );
  }

  try {
    // ── Parse body ──────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const userWallet = (body.user_wallet || "").trim().toLowerCase();
    const budgetUsdc = Number(body.budget_usdc) || 0.01;

    // ── Retry detection ─────────────────────────────────────
    const customerPaymentSignature =
      req.headers.get("payment-signature") ||
      req.headers.get("x-payment");

    const retryRunId =
      req.nextUrl.searchParams.get("runId") ||
      body.discovery_run_id ||
      body.run_id ||
      null;

    // Fail closed: paid retry MUST include runId
    if (customerPaymentSignature && !retryRunId) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_run_id: paid retry must include discovery_run_id/runId",
        },
        { status: 400 },
      );
    }

    // On first request (no retryRunId), user_wallet is required
    if (!retryRunId) {
      if (!userWallet || !/^0x[a-fA-F0-9]{40}$/.test(userWallet)) {
        return NextResponse.json(
          { ok: false, error: "user_wallet must be a valid EVM address" },
          { status: 400 },
        );
      }
    }

    // ── Load or validate discovery run ──────────────────────
    let discoveryRunId: string;
    let resolvedWallet = userWallet;
    let resolvedBudget = budgetUsdc;
    let resolvedGoal = "";

    if (retryRunId) {
      const { data: existingRun, error: existingErr } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("id, user_wallet, goal, budget_usdc, agent_trace, status, effective_route_tier")
        .eq("id", retryRunId)
        .single();

      if (existingErr || !existingRun) {
        return NextResponse.json(
          { ok: false, error: "invalid_run_id: discovery run not found" },
          { status: 404 },
        );
      }

      // Wallet mismatch check
      if (userWallet && existingRun.user_wallet?.toLowerCase() !== userWallet) {
        return NextResponse.json(
          { ok: false, error: "run_wallet_mismatch" },
          { status: 403 },
        );
      }

      discoveryRunId = existingRun.id;
      resolvedWallet = existingRun.user_wallet?.toLowerCase() || userWallet;
      resolvedBudget = Number(existingRun.budget_usdc) || budgetUsdc;
      resolvedGoal = existingRun.goal || "";

      // Validate preflight state
      const agentTrace = (existingRun.agent_trace as Record<string, unknown>) || {};
      const preflight = agentTrace.auto_tier_preflight as Record<string, unknown> | undefined;

      if (!preflight || preflight.status !== "locked") {
        return NextResponse.json(
          {
            ok: false,
            error: "preflight_not_locked: route-preflight must complete before execute-locked",
          },
          { status: 400 },
        );
      }
    } else {
      // First request — need discovery_run_id from preflight
      // The discovery_run_id should be provided in the body
      const providedRunId = body.discovery_run_id || body.run_id;
      if (!providedRunId) {
        return NextResponse.json(
          { ok: false, error: "discovery_run_id required (from route-preflight)" },
          { status: 400 },
        );
      }

      const { data: existingRun, error: existingErr } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("id, user_wallet, goal, budget_usdc, agent_trace, status, effective_route_tier")
        .eq("id", providedRunId)
        .single();

      if (existingErr || !existingRun) {
        return NextResponse.json(
          { ok: false, error: "invalid_run_id: discovery run not found" },
          { status: 404 },
        );
      }

      // Wallet mismatch check
      if (existingRun.user_wallet?.toLowerCase() !== userWallet) {
        return NextResponse.json(
          { ok: false, error: "run_wallet_mismatch" },
          { status: 403 },
        );
      }

      // Validate preflight state
      const agentTrace = (existingRun.agent_trace as Record<string, unknown>) || {};
      const preflight = agentTrace.auto_tier_preflight as Record<string, unknown> | undefined;

      if (!preflight || preflight.status !== "locked") {
        return NextResponse.json(
          {
            ok: false,
            error: "preflight_not_locked: route-preflight must complete before execute-locked",
          },
          { status: 400 },
        );
      }

      discoveryRunId = existingRun.id;
      resolvedWallet = existingRun.user_wallet?.toLowerCase() || userWallet;
      resolvedBudget = Number(existingRun.budget_usdc) || budgetUsdc;
      resolvedGoal = existingRun.goal || "";
    }

    // ── Load preflight data from agent_trace ────────────────
    const { data: runRow } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("agent_trace, effective_route_tier")
      .eq("id", discoveryRunId)
      .single();

    const agentTrace = (runRow?.agent_trace as Record<string, unknown>) || {};
    const preflight = agentTrace.auto_tier_preflight as Record<string, unknown>;

    const lockedTier = preflight.selected_tier as DelegatedRouteTier;
    const finalEntryPaymentUsdc = Number(preflight.final_entry_payment_usdc);
    const brainFields = preflight.brain_fields as Record<string, unknown>;
    const routingPayment = preflight.routing_payment as Record<string, unknown>;
    const brainPayment = preflight.brain_payment as Record<string, unknown> | null;
    const brainLlmDiag = preflight.brain_llm_diag as Record<string, unknown> | null;

    // Reconstruct safe brain planning from preflight brain_fields (full parity with inline)
    const safeBrainPlanning = brainFields
      ? {
          normalized_goal: brainFields.normalized_goal ?? null,
          route_tier_hint: brainFields.route_tier_hint ?? lockedTier,
          discovery_strategy: brainFields.discovery_strategy ?? null,
          suggested_query_variants: brainFields.suggested_query_variants ?? [],
          service_execution_plan: brainFields.service_execution_plan ?? [],
          safe_brain_summary: brainFields.safe_brain_summary ?? null,
          assistant_response: brainFields.assistant_response ?? null,
          user_visible_reasoning: brainFields.user_visible_reasoning ?? null,
          tier_decision_reason: brainFields.tier_decision_reason ?? null,
          plan_rationale: brainFields.plan_rationale ?? null,
          selected_macro_nodes: brainFields.selected_macro_nodes ?? preflight.locked_selected_macro_nodes ?? [],
          selected_services: brainFields.selected_services ?? preflight.locked_selected_services ?? [],
          max_registry_checks: brainFields.max_registry_checks ?? null,
          max_source_accesses: brainFields.max_source_accesses ?? null,
          planned_cost_usdc: preflight.locked_planned_cost_usdc ?? null,
          planned_cost_breakdown: preflight.locked_planned_cost_breakdown ?? null,
        }
      : null;

    // ── Import x402 primitives ──────────────────────────────
    const {
      buildCustomerEntryChallenge,
      verifyAndSettleCustomerEntry,
      buildCustomerEntryPaymentData,
    } = await import("@/lib/paylabs/x402/customer-entry-payment");

    // ── No payment signature → return 402 challenge ─────────
    if (!customerPaymentSignature) {
      const { baseUrl: publicBase } = resolvePublicAppUrl();
      const retryUrl = `${publicBase}/api/paylabs/discovery-runs/execute-locked?runId=${discoveryRunId}`;

      // Guard: finalEntryPaymentUsdc must be positive
      if (finalEntryPaymentUsdc <= 0) {
        return NextResponse.json(
          { ok: false, error: `Invalid final entry payment: ${finalEntryPaymentUsdc}` },
          { status: 500 },
        );
      }

      const { headerValue } = buildCustomerEntryChallenge(
        finalEntryPaymentUsdc,
        retryUrl,
      );

      // Store awaiting payment status (merge agent_trace)
      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          agent_trace: {
            ...agentTrace,
            auto_tier_execution: {
              status: "awaiting_final_payment",
              final_entry_payment_usdc: finalEntryPaymentUsdc,
            },
          },
        })
        .eq("id", discoveryRunId);

      return new NextResponse(
        JSON.stringify({
          ok: false,
          error: "payment_required",
          discovery_run_id: discoveryRunId,
          retry_url: retryUrl,
          final_entry_payment_usdc: finalEntryPaymentUsdc,
          message: `Final entry payment of ${finalEntryPaymentUsdc} USDC required for ${lockedTier} tier`,
        }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": headerValue,
            "x-payment-required": headerValue,
          },
        },
      );
    }

    // ── Verify + settle final entry payment ─────────────────
    const entryResult = await verifyAndSettleCustomerEntry(
      customerPaymentSignature,
      finalEntryPaymentUsdc,
    );

    // Fail closed if payment invalid
    if (!entryResult.ok || !entryResult.settled) {
      const entryErrorMsg = entryResult.error || "Final entry payment verification failed";

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: `execute_locked_payment_failed: ${entryErrorMsg}`.slice(0, 500),
          agent_trace: {
            ...agentTrace,
            auto_tier_execution: {
              status: "payment_failed",
              error: entryErrorMsg.slice(0, 300),
            },
          },
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        {
          ok: false,
          error: `Final entry payment failed: ${entryErrorMsg}`,
        },
        { status: 402 },
      );
    }

    // Payer check
    const payer = entryResult.payer?.toLowerCase();
    if (payer && payer !== resolvedWallet) {
      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: `execute_locked_payer_mismatch: expected=${resolvedWallet} got=${payer}`,
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        { ok: false, error: "Final entry payment payer does not match claimed user wallet" },
        { status: 403 },
      );
    }

    // ── Store final entry payment metadata (safe, no raw signatures) ──
    const finalPaymentMeta = {
      status: "paid",
      amount_usdc: finalEntryPaymentUsdc,
      tx_hash: entryResult.paymentMeta?.txHash ?? null,
      explorer_url: entryResult.paymentMeta?.explorerUrl ?? null,
      settlement_id: entryResult.paymentMeta?.settlementId ?? null,
      settlement_url: entryResult.paymentMeta?.settlementUrl ?? null,
      batch_tx_hash: entryResult.paymentMeta?.batchTxHash ?? null,
      batch_explorer_url: entryResult.paymentMeta?.batchExplorerUrl ?? null,
      batch_resolver_url: entryResult.paymentMeta?.batchResolverUrl ?? null,
      gateway_accepted: entryResult.paymentMeta?.gatewayAccepted ?? true,
    };

    // Store entry payment on discovery_runs columns
    const entryPaymentData = buildCustomerEntryPaymentData(
      resolvedWallet,
      {
        routeTier: lockedTier,
        plannedCostUsdc: finalEntryPaymentUsdc,
        expectedPaymentEdges: 0, // not applicable for locked execution
      },
      entryResult,
    );

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        entry_payment_status: "paid",
        entry_payment_amount_usdc: finalEntryPaymentUsdc,
        entry_payment_tx_hash: finalPaymentMeta.tx_hash,
        entry_payment_explorer_url: finalPaymentMeta.explorer_url,
        entry_payment_settlement_id: finalPaymentMeta.settlement_id,
        entry_payment_batch_tx_hash: finalPaymentMeta.batch_tx_hash,
        entry_payment_batch_explorer_url: finalPaymentMeta.batch_explorer_url,
        agent_trace: {
          ...agentTrace,
          auto_tier_execution: {
            status: "final_payment_settled",
            final_entry_payment_usdc: finalEntryPaymentUsdc,
            final_payment: finalPaymentMeta,
          },
        },
      })
      .eq("id", discoveryRunId);

    // ── Reconstruct ExecutionPlan from preflight trace ──────
    const lockedPlan = reconstructLockedPlan({
      selected_tier: preflight.selected_tier as string,
      locked_selected_macro_nodes: preflight.locked_selected_macro_nodes as string[],
      locked_selected_services: preflight.locked_selected_services as string[],
      locked_planned_cost_usdc: preflight.locked_planned_cost_usdc as number,
      locked_planned_cost_breakdown: preflight.locked_planned_cost_breakdown as {
        brain_treasury_usdc: number;
        macro_node_fees_usdc: number;
        service_edge_fees_usdc: number;
        registry_check_fees_usdc: number;
        source_access_fees_usdc: number;
      },
    });

    // ── Initialize DCW signer ───────────────────────────────
    const { createDcwSigner } = await import("@/lib/paylabs/x402/dcw-signer-adapter");
    const dcwSigner = createDcwSigner();

    // ── Run locked macro-node pipeline ──────────────────────
    const { output: result } = await executeLockedMacroNodePipeline({
      discoveryRunId,
      userGoal: resolvedGoal,
      userWallet: resolvedWallet,
      userBudgetUsdc: resolvedBudget,
      lockedTier,
      lockedPlan,
      brainData: brainFields,
      dcwSigner,
      callMacroNode: callMacroNodeX402,
      buildOutput: buildLockedOutput,
    });

    // ── Prepend controller→brain edge (execution parity with old inline) ──
    // Old inline payment graph: controller → brain → macro-node → child service
    // Locked orchestration starts at brain → macro-node. We prepend the brain edge
    // from preflight brain_payment metadata so the canonical graph is complete.
    if (brainPayment) {
      const brainEdge = {
        edge_id: `brain-${discoveryRunId}`,
        buyer: "run_budget_controller",
        seller: "brain",
        amount_usdc: Number(brainPayment.amount_usdc) || 0.000003,
        status: "paid",
        node_type: "brain",
        tx_hash: (brainPayment.tx_hash as string) ?? null,
        explorer_url: (brainPayment.explorer_url as string) ?? null,
        settlement_id: (brainPayment.settlement_id as string) ?? null,
        settlement_url: (brainPayment.settlement_url as string) ?? null,
        batch_tx_hash: (brainPayment.batch_tx_hash as string) ?? null,
        batch_explorer_url: (brainPayment.batch_explorer_url as string) ?? null,
        batch_resolver_url: (brainPayment.batch_resolver_url as string) ?? null,
        gateway_accepted: (brainPayment.gateway_accepted as boolean) ?? true,
        transfer_status: (brainPayment.transfer_status as string) ?? null,
        error: null,
        mode: (brainPayment.mode as string) ?? "x402",
      };
      // Prepend to result.paymentGraph (mutable push + unshift)
      result.paymentGraph.unshift({
        edgeId: brainEdge.edge_id,
        buyer: brainEdge.buyer,
        seller: brainEdge.seller,
        amountUsdc: brainEdge.amount_usdc,
        status: "paid",
        nodeType: "brain",
        paymentRef: null,
        txHash: brainEdge.tx_hash,
        explorerUrl: brainEdge.explorer_url,
        settlementId: brainEdge.settlement_id,
        settlementUrl: brainEdge.settlement_url,
        batchTxHash: brainEdge.batch_tx_hash,
        batchExplorerUrl: brainEdge.batch_explorer_url,
        batchResolverUrl: brainEdge.batch_resolver_url,
        gatewayAccepted: brainEdge.gateway_accepted,
        transferStatus: brainEdge.transfer_status as PaymentGraphEdge["transferStatus"],
        error: null,
        mode: brainEdge.mode,
      } as PaymentGraphEdge);
    }

    // ── Recompute budget snapshot to include controller→brain edge ──
    // buildLockedOutput computes budgetSnapshot before brain edge is prepended.
    // Recompute key fields now that the canonical graph includes controller→brain.
    if (brainPayment) {
      const brainAmount = Number(brainPayment.amount_usdc) || 0.000003;
      const allPaidEdges = result.paymentGraph.filter((e) => e.status === "paid");
      const controllerBrainPaid = allPaidEdges.filter(
        (e) => e.buyer === "run_budget_controller" && e.seller === "brain"
      );
      const brainMacroPaid = allPaidEdges.filter(
        (e) => e.buyer === "brain" && e.nodeType === "macro_node"
      );
      const childPaid = allPaidEdges.filter((e) => e.nodeType === "service");

      const treasuryFee = controllerBrainPaid.reduce((s, e) => s + e.amountUsdc, 0);
      const macroAlloc = brainMacroPaid.reduce((s, e) => s + e.amountUsdc, 0);
      const childVol = childPaid.reduce((s, e) => s + e.amountUsdc, 0);
      const userBudgetUsed = treasuryFee + macroAlloc;

      result.budgetSnapshot = {
        ...result.budgetSnapshot,
        spentUsdc: userBudgetUsed,
        remainingUsdc: Math.max(0, resolvedBudget - userBudgetUsed),
        userBudgetUsedUsdc: userBudgetUsed,
        remainingBudgetUsdc: Math.max(0, resolvedBudget - userBudgetUsed),
        treasuryFeeUsdc: treasuryFee || brainAmount,
        macroAllocationUsdc: macroAlloc,
        childPaymentVolumeUsdc: childVol,
        grossPaymentVolumeUsdc: userBudgetUsed + childVol,
      };
    }

    // ── Store orchestration result ──────────────────────────
    const completedAt = new Date().toISOString();
    const newStatus = result.status === "completed"
      ? result.paymentGraph.some((e) => e.status === "paid") ? "paid_path_available" : "discovery_only"
      : "failed";

    const fullySettled = result.status === "completed"
      && result.paymentGraph.length > 0
      && result.paymentGraph.every((e) => e.status === "paid");

    // Read existing agent_trace to merge
    const { data: traceBeforeFinal } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("agent_trace")
      .eq("id", discoveryRunId)
      .single();
    const existingTrace = (traceBeforeFinal?.agent_trace as Record<string, unknown>) || {};

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: newStatus,
        completed_at: completedAt,
        error_summary: result.error ? result.error.slice(0, 500) : null,
        agent_trace: {
          ...existingTrace,
          execution_origin: "vercel_execute_locked",
          execution_mode: "x402_locked_orchestration",
          x402_enabled: true,
          phases_completed: result.phasesCompleted,
          _brain_diag: brainLlmDiag
            ? {
                error_code: brainLlmDiag.error_code ?? null,
                error_safe: brainLlmDiag.error_safe ?? null,
                provider: brainLlmDiag.provider ?? "unknown",
                model: brainLlmDiag.model ?? "unknown",
                agent_name: brainLlmDiag.agent_name ?? "unknown",
                mode: brainLlmDiag.mode ?? "unknown",
                max_tokens: brainLlmDiag.max_tokens ?? null,
                timeout_ms: brainLlmDiag.timeout_ms ?? null,
                streaming: brainLlmDiag.streaming ?? null,
                force_non_streaming_body: brainLlmDiag.force_non_streaming_body ?? null,
                json_found: brainLlmDiag.json_found ?? null,
                parse_ok: brainLlmDiag.parse_ok ?? null,
                validation_ok: brainLlmDiag.validation_ok ?? null,
                received_keys: brainLlmDiag.received_keys ?? null,
                expected_keys: brainLlmDiag.expected_keys ?? null,
                validation_issue_paths: brainLlmDiag.validation_issue_paths ?? null,
                content_type: brainLlmDiag.content_type ?? null,
                content_length: brainLlmDiag.content_length ?? null,
                safe_error: brainLlmDiag.safe_error ?? null,
              }
            : null,
          brain_planning: safeBrainPlanning,
          payment_graph: result.paymentGraph.map((e) => ({
            edge_id: e.edgeId,
            buyer: e.buyer,
            seller: e.seller,
            amount_usdc: e.amountUsdc,
            status: e.status,
            node_type: e.nodeType,
            tx_hash: e.txHash ?? null,
            explorer_url: e.explorerUrl ?? null,
            settlement_id: e.settlementId ?? null,
            settlement_url: e.settlementUrl ?? null,
            batch_tx_hash: e.batchTxHash ?? null,
            batch_explorer_url: e.batchExplorerUrl ?? null,
            batch_resolver_url: e.batchResolverUrl ?? null,
            gateway_accepted: e.gatewayAccepted ?? (e.status === "paid"),
            transfer_status: e.transferStatus ?? null,
            error: e.error ?? null,
            mode: e.mode ?? null,
          })),
          budget_snapshot: result.budgetSnapshot,
          payment_plan: result.paymentPlan ?? null,
          safe_progress_summaries: result.safeProgressSummaries,
          tiered_summaries: result.tieredSummaries,
          quote: {
            routeTier: lockedTier,
            expectedPaymentEdges: 1 + lockedPlan.selectedMacroNodes.length + lockedPlan.selectedServices.length,
            plannedCostUsdc: lockedPlan.plannedCostUsdc,
            budgetStatus: "within_budget",
            macroNodeFeesUsdc: lockedPlan.plannedCostBreakdown.macro_node_fees_usdc,
            serviceEdgeFeesUsdc: lockedPlan.plannedCostBreakdown.service_edge_fees_usdc,
            registryCheckFeesUsdc: lockedPlan.plannedCostBreakdown.registry_check_fees_usdc,
            sourceAccessFeesUsdc: lockedPlan.plannedCostBreakdown.source_access_fees_usdc,
            locked: true,
          },
          settled: fullySettled,
          mode: fullySettled ? "x402" : "x402_failed",
        },
      })
      .eq("id", discoveryRunId);

    // ── Build exit output ───────────────────────────────────
    const { buildExitOutput } = await import("@/lib/paylabs/delegated-runtime/exit-output");
    const exitOutput = buildExitOutput(result);

    // Source context
    if (result.sourceContext) {
      exitOutput.sources_used = result.sourceContext.sources_used;
      exitOutput.source_selection_summary = result.sourceContext.source_selection_summary;
      exitOutput.source_confidence = result.sourceContext.source_confidence;
      exitOutput.source_count = result.sourceContext.source_count;
      exitOutput.source_retrieval_mode = result.sourceContext.retrieval_mode;
    }

    // Final answer
    let finalAnswer: string | null = null;
    try {
      const { buildSourceGroundedFinalAnswer } = await import("@/lib/paylabs/sources/source-final-answer");
      const sourcesUsed = exitOutput.sources_used || [];
      finalAnswer = buildSourceGroundedFinalAnswer({
        goal: resolvedGoal,
        sourcesUsed,
        sourceConfidence: exitOutput.source_confidence || 0,
        retrievalMode: exitOutput.source_retrieval_mode || (sourcesUsed.length > 0
          ? (sourcesUsed.some((s: { source_kind?: string }) => s.source_kind === "rsshub_live") ? "rsshub_live" : "db_fallback")
          : "none"),
      });
    } catch (e: unknown) {
      console.error("[execute_locked] final_answer build failed", {
        error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
      });
    }

    // Store source context + final_answer
    if (exitOutput.source_retrieval_mode || (exitOutput.sources_used && exitOutput.sources_used.length > 0)) {
      try {
        const { data: existingRun } = await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("agent_trace")
          .eq("id", discoveryRunId)
          .single();
        const trace = (existingRun?.agent_trace as Record<string, unknown>) || {};

        await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .update({
            agent_trace: {
              ...trace,
              source_context: {
                source_count: exitOutput.source_count || 0,
                source_confidence: exitOutput.source_confidence || 0,
                retrieval_mode: exitOutput.source_retrieval_mode || "rsshub_live_empty",
                sources_used: (exitOutput.sources_used || []).slice(0, 20).map((s) => ({
                  title: s.title,
                  url: s.url,
                  domain: s.domain,
                  rank: s.rank,
                  source_kind: s.source_kind,
                  provider: s.provider,
                })),
              },
              final_answer: finalAnswer,
              exit_output: exitOutput,
            },
          })
          .eq("id", discoveryRunId);
      } catch (e: unknown) {
        console.error("[execute_locked] source snapshot store failed", {
          error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
        });
      }
    }

    // Persist exit_output unconditionally — recovery path reads agentTrace.exit_output
    if (!exitOutput.source_retrieval_mode && !(exitOutput.sources_used && exitOutput.sources_used.length > 0)) {
      try {
        const { data: traceRow } = await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("agent_trace")
          .eq("id", discoveryRunId)
          .single();
        const mergedTrace = (traceRow?.agent_trace as Record<string, unknown>) || {};
        await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .update({
            agent_trace: { ...mergedTrace, exit_output: exitOutput },
          })
          .eq("id", discoveryRunId);
      } catch (e: unknown) {
        console.error("[execute_locked] exit_output persist failed", {
          error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
        });
      }
    }

    // ── Write visibility ────────────────────────────────────
    let visibilityError: string | null = null;
    try {
      const { writePayLabsVisibility } = await import("@/lib/paylabs/visibility/writer");
      await writePayLabsVisibility({
        discoveryRunId,
        userWallet: resolvedWallet,
        routeTier: lockedTier,
        result,
      });
    } catch (e) {
      visibilityError = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      console.error("[execute_locked] visibility write failed", {
        discoveryRunId,
        error: visibilityError,
      });
    }

    // ── Return response ─────────────────────────────────────
    return NextResponse.json({
      ok: result.status === "completed",
      final_answer: finalAnswer,
      discovery_run_id: discoveryRunId,
      status: result.status,
      requested_route_tier: "auto",
      effective_route_tier: lockedTier,
      route_tier: lockedTier,
      brain_route_tier_hint: lockedTier,
      // User payment metadata (separate from internal payment graph)
      preflight_routing_payment: routingPayment,
      final_entry_payment: finalPaymentMeta,
      user_cost_usdc: Number(preflight.routing_fee_usdc || 0) + finalEntryPaymentUsdc,
      locked_execution_plan: {
        selected_macro_nodes: lockedPlan.selectedMacroNodes,
        selected_services: lockedPlan.selectedServices,
        planned_cost_usdc: lockedPlan.plannedCostUsdc,
        planned_cost_breakdown: lockedPlan.plannedCostBreakdown,
        locked: true,
      },
      // Brain planning fields (full parity with old inline Vercel)
      _brain_diag: brainLlmDiag
        ? {
            error_code: brainLlmDiag.error_code ?? null,
            error_safe: brainLlmDiag.error_safe ?? null,
            provider: brainLlmDiag.provider ?? "unknown",
            model: brainLlmDiag.model ?? "unknown",
            agent_name: brainLlmDiag.agent_name ?? "unknown",
            mode: brainLlmDiag.mode ?? "unknown",
            max_tokens: brainLlmDiag.max_tokens ?? null,
            timeout_ms: brainLlmDiag.timeout_ms ?? null,
            streaming: brainLlmDiag.streaming ?? null,
            force_non_streaming_body: brainLlmDiag.force_non_streaming_body ?? null,
            json_found: brainLlmDiag.json_found ?? null,
            parse_ok: brainLlmDiag.parse_ok ?? null,
            validation_ok: brainLlmDiag.validation_ok ?? null,
            received_keys: brainLlmDiag.received_keys ?? null,
            expected_keys: brainLlmDiag.expected_keys ?? null,
            validation_issue_paths: brainLlmDiag.validation_issue_paths ?? null,
            content_type: brainLlmDiag.content_type ?? null,
            content_length: brainLlmDiag.content_length ?? null,
            safe_error: brainLlmDiag.safe_error ?? null,
          }
        : null,
      execution_origin: "vercel_execute_locked",
      execution_mode: "x402_locked_orchestration",
      worker_used: false,
      x402_enabled: true,
      phases_completed: result.phasesCompleted,
      brain_planning: safeBrainPlanning,
      payment_plan: result.paymentPlan ?? null,
      payment_graph: result.paymentGraph.map((e) => ({
        edge_id: e.edgeId,
        buyer: e.buyer,
        seller: e.seller,
        amount_usdc: e.amountUsdc,
        status: e.status,
        node_type: e.nodeType,
        tx_hash: e.txHash ?? null,
        explorer_url: e.explorerUrl ?? null,
        settlement_id: e.settlementId ?? null,
        settlement_url: e.settlementUrl ?? null,
        batch_tx_hash: e.batchTxHash ?? null,
        batch_explorer_url: e.batchExplorerUrl ?? null,
        batch_resolver_url: e.batchResolverUrl ?? null,
        gateway_accepted: e.gatewayAccepted ?? (e.status === "paid"),
        transfer_status: e.transferStatus ?? null,
        error: e.error ?? null,
        mode: e.mode ?? null,
      })),
      safe_progress_summaries: result.safeProgressSummaries,
      budget_snapshot: result.budgetSnapshot,
      tiered_summaries: result.tieredSummaries,
      exit_output: exitOutput,
      source_context: result.sourceContext ?? {
        sources_used: exitOutput.sources_used ?? [],
        source_count: exitOutput.source_count ?? 0,
        source_confidence: exitOutput.source_confidence ?? 0,
        retrieval_mode: exitOutput.source_retrieval_mode ?? null,
      },
      source_context_error: null,
      quote: {
        routeTier: lockedTier,
        expectedPaymentEdges: 1 + lockedPlan.selectedMacroNodes.length + lockedPlan.selectedServices.length,
        plannedCostUsdc: lockedPlan.plannedCostUsdc,
        budgetStatus: "within_budget",
        macroNodeFeesUsdc: lockedPlan.plannedCostBreakdown.macro_node_fees_usdc,
        serviceEdgeFeesUsdc: lockedPlan.plannedCostBreakdown.service_edge_fees_usdc,
        registryCheckFeesUsdc: lockedPlan.plannedCostBreakdown.registry_check_fees_usdc,
        sourceAccessFeesUsdc: lockedPlan.plannedCostBreakdown.source_access_fees_usdc,
        locked: true,
      },
      receipt_ready: exitOutput.receipt_ready && !visibilityError,
      settled: fullySettled,
      mode: fullySettled ? "x402" : "x402_failed",
      entry_payment: {
        status: "paid",
        amount_usdc: finalEntryPaymentUsdc,
        tx_hash: finalPaymentMeta.tx_hash,
        explorer_url: finalPaymentMeta.explorer_url,
        settlement_id: finalPaymentMeta.settlement_id,
        settlement_url: finalPaymentMeta.settlement_url ?? null,
        batch_tx_hash: finalPaymentMeta.batch_tx_hash,
        batch_explorer_url: finalPaymentMeta.batch_explorer_url,
        batch_resolver_url: finalPaymentMeta.batch_resolver_url ?? null,
        gateway_accepted: finalPaymentMeta.gateway_accepted,
        transfer_status: (finalPaymentMeta as Record<string, unknown>).transfer_status ?? null,
        customer_wallet: resolvedWallet,
        customer_wallet_type: "circle_developer_controlled",
      },
      entry_payment_explorer_url: finalPaymentMeta.explorer_url,
      entry_payment_batch_explorer_url: finalPaymentMeta.batch_explorer_url,
      entry_payment_settlement_id: finalPaymentMeta.settlement_id,
      entry_payment_batch_resolver_url: finalPaymentMeta.batch_resolver_url ?? null,
      error: result.error,
      visibility_error: visibilityError,
    });
  } catch (e: unknown) {
    const rawMsg = e instanceof Error ? e.message : String(e);
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;
    console.error("[execute_locked] Error:", safeMsg);
    return NextResponse.json(
      { ok: false, error: `Execute-locked failed: ${safeMsg}` },
      { status: 500 },
    );
  }
}
