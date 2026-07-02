/**
 * POST /api/paylabs/discovery-runs/route-preflight
 *
 * Route-only preflight endpoint for auto-tier selection.
 * Charges 0.000001 USDC via Circle x402, runs Brain LLM planner
 * to select the optimal tier, locks the execution plan + quote,
 * and returns safe metadata for the final entry payment challenge.
 *
 * Gated behind PAYLABS_AUTO_TIER_PREFLIGHT_ENABLED feature flag.
 * When flag is false, returns 404 — does not affect existing flow.
 *
 * Flow:
 *   1st request (no payment) → 402 + x402 challenge (0.000001 USDC)
 *   2nd request (with payment) → verify/settle → Brain preflight → locked tier
 *
 * Does NOT:
 * - Run final internal orchestration
 * - Build final entry payment challenge
 * - Run macro-node x402 payments
 * - Run child service x402 payments
 * - Buy sources
 * - Create creator payouts
 * - Update receipt UI
 *
 * Uses existing Circle x402 primitives:
 * - Challenge: buildCustomerEntryChallenge (seller-challenge.ts)
 * - Verify/Settle: verifyAndSettleCustomerEntry (customer-entry-payment.ts)
 * - Explorer URLs: payment-links.ts (buildTxExplorerUrl, buildBatchResolverUrl, etc.)
 *
 * Safety:
 * - Never stores raw x-payment, PAYMENT-SIGNATURE, EIP-712 data, or Gateway response.
 * - Never exposes raw signatures, private keys, or secrets.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  // ── Gate: feature flag ────────────────────────────────────
  if (!isAutoTierPreflightEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Auto-tier preflight is not enabled" },
      { status: 404 },
    );
  }

  try {
    // ── Parse body ──────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const goal = (body.goal || "").trim();
    const userWallet = (body.user_wallet || "").trim().toLowerCase();
    const budgetUsdc = Number(body.budget_usdc) || 0.01;

    // ── Requested tier (auto by default, explicit for normal/advanced) ──
    const requestedRouteTierRaw = body.route_tier || body.routeTier || "auto";
    const requestedRouteTier = requestedRouteTierRaw === "standard" ? "auto" : requestedRouteTierRaw;
    if (!["auto", "easy", "normal", "advanced"].includes(requestedRouteTier)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported route tier: ${requestedRouteTierRaw}` },
        { status: 400 },
      );
    }

    // ── Retry detection ─────────────────────────────────────
    const customerPaymentSignature =
      req.headers.get("payment-signature") ||
      req.headers.get("x-payment");

    const retryRunId =
      req.nextUrl.searchParams.get("runId") ||
      body.discovery_run_id ||
      body.run_id ||
      null;

    // Fail closed: paid retry MUST include runId from the 402 challenge
    if (customerPaymentSignature && !retryRunId) {
      return NextResponse.json(
        {
          ok: false,
          error: "missing_run_id: paid retry must include discovery_run_id/runId from the 402 challenge",
        },
        { status: 400 },
      );
    }

    // On first request (no retryRunId), goal and wallet are required
    if (!retryRunId) {
      if (!goal) {
        return NextResponse.json(
          { ok: false, error: "goal is required" },
          { status: 400 },
        );
      }
      if (!userWallet || !/^0x[a-fA-F0-9]{40}$/.test(userWallet)) {
        return NextResponse.json(
          { ok: false, error: "user_wallet must be a valid EVM address" },
          { status: 400 },
        );
      }
      if (budgetUsdc <= 0) {
        return NextResponse.json(
          { ok: false, error: "budget_usdc must be positive" },
          { status: 400 },
        );
      }
    }

    // ── Import x402 primitives ──────────────────────────────
    const {
      buildCustomerEntryChallenge,
      verifyAndSettleCustomerEntry,
    } = await import("@/lib/paylabs/x402/customer-entry-payment");

    const { resolvePublicAppUrl } = await import(
      "@/lib/paylabs/runtime/resolve-app-url"
    );

    const {
      ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
      runRouteOnlyBrainPreflight,
      buildRoutePreflightResponse,
      buildRoutePreflightPaymentMeta,
    } = await import(
      "@/lib/paylabs/delegated-runtime/auto-tier-preflight"
    );

    // ── Create or reuse discovery run row ───────────────────
    let discoveryRunId: string;
    let resolvedGoal = goal;
    let resolvedWallet = userWallet;
    let resolvedBudget = budgetUsdc;
    let resolvedRequestedRouteTier = requestedRouteTier;

    if (retryRunId) {
      // Paid retry: load existing row (same pattern as inline route)
      const { data: existingRun, error: existingErr } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("id,user_wallet,goal,budget_usdc,agent_trace,status")
        .eq("id", retryRunId)
        .single();

      if (existingErr || !existingRun) {
        return NextResponse.json(
          { ok: false, error: "invalid_run_id: discovery run not found" },
          { status: 404 },
        );
      }

      // Wallet mismatch: body user_wallet differs from DB stored wallet
      if (userWallet && existingRun.user_wallet?.toLowerCase() !== userWallet) {
        return NextResponse.json(
          { ok: false, error: "run_wallet_mismatch" },
          { status: 403 },
        );
      }

      discoveryRunId = existingRun.id;
      resolvedGoal = existingRun.goal || goal;
      resolvedWallet = existingRun.user_wallet?.toLowerCase() || userWallet;
      resolvedBudget = Number(existingRun.budget_usdc) || budgetUsdc;

      // Load requested tier from stored trace when body does not provide it
      const existingTrace = (existingRun.agent_trace as Record<string, unknown>) || {};
      const existingPreflight = existingTrace.auto_tier_preflight as Record<string, unknown> | undefined;
      resolvedRequestedRouteTier = (existingPreflight?.requested_route_tier as string | undefined) || requestedRouteTier || "auto";
    } else {
      // First request: create new row
      const now = new Date().toISOString();
      const { data: runRow, error: runErr } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .insert({
          goal: resolvedGoal.slice(0, 2000),
          user_wallet: resolvedWallet,
          route_tier: requestedRouteTier === "auto" ? "auto" : requestedRouteTier,
          status: "running",
          started_at: now,
          budget_usdc: resolvedBudget,
          runner_id: "route-preflight",
          agent_trace: {
            auto_tier_preflight: {
              status: "preflight_pending",
              requested_route_tier: requestedRouteTier,
            },
          },
        })
        .select("id")
        .single();

      if (runErr || !runRow) {
        return NextResponse.json(
          {
            ok: false,
            error: `Failed to create discovery run: ${runErr?.message || "unknown"}`,
          },
          { status: 500 },
        );
      }

      discoveryRunId = runRow.id as string;
    }

    // ── No payment signature → return 402 challenge ─────────
    if (!customerPaymentSignature) {
      const { baseUrl: publicBase } = resolvePublicAppUrl();
      const retryUrl = `${publicBase}/api/paylabs/discovery-runs/route-preflight?runId=${discoveryRunId}`;

      const { headerValue } = buildCustomerEntryChallenge(
        ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
        retryUrl,
      );

      // Store pending preflight status in agent_trace
      const { data: existingTrace } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("agent_trace")
        .eq("id", discoveryRunId)
        .single();

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "running",
          agent_trace: {
            ...((existingTrace?.agent_trace as Record<string, unknown>) || {}),
            auto_tier_preflight: {
              status: "awaiting_payment",
              requested_route_tier: resolvedRequestedRouteTier,
              routing_fee_usdc: ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
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
          routing_fee_usdc: ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
          message: `Route preflight fee of ${ROUTE_PREFLIGHT_ROUTING_FEE_USDC} USDC required`,
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

    // ── Verify + settle customer entry payment ──────────────
    const entryResult = await verifyAndSettleCustomerEntry(
      customerPaymentSignature,
      ROUTE_PREFLIGHT_ROUTING_FEE_USDC,
    );

    // Fail closed if payment is invalid
    if (!entryResult.ok || !entryResult.settled) {
      const entryErrorMsg = entryResult.error || "Route preflight payment verification failed";

      // Merge existing agent_trace — preserve prior data
      const { data: traceOnPayFail } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("agent_trace")
        .eq("id", discoveryRunId)
        .single();

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: `route_preflight_payment_failed: ${entryErrorMsg}`.slice(0, 500),
          agent_trace: {
            ...((traceOnPayFail?.agent_trace as Record<string, unknown>) || {}),
            auto_tier_preflight: {
              status: "payment_failed",
              error: entryErrorMsg.slice(0, 300),
            },
          },
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        {
          ok: false,
          error: `Route preflight payment failed: ${entryErrorMsg}`,
        },
        { status: 402 },
      );
    }

    // Payer check: reject only if payer exists and differs from stored wallet.
    // If payer is null/undefined (ARC-TESTNET returns null), skip check — same as inline route.
    const payer = entryResult.payer?.toLowerCase();
    if (payer && payer !== resolvedWallet) {
      // Merge existing agent_trace — preserve prior data
      const { data: traceOnPayerMismatch } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("agent_trace")
        .eq("id", discoveryRunId)
        .single();

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: `route_preflight_payer_mismatch: expected=${resolvedWallet} got=${payer}`,
          agent_trace: {
            ...((traceOnPayerMismatch?.agent_trace as Record<string, unknown>) || {}),
            auto_tier_preflight: {
              status: "payer_mismatch",
              expected: resolvedWallet,
              got: payer,
            },
          },
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        { ok: false, error: "Route preflight payment payer does not match claimed user wallet" },
        { status: 403 },
      );
    }

    // ── Payment settled — run route-only Brain preflight ────
    const paymentMeta = buildRoutePreflightPaymentMeta(entryResult);

    let preflightResult;
    try {
      preflightResult = await runRouteOnlyBrainPreflight({
        discoveryRunId,
        userGoal: resolvedGoal,
        userBudgetUsdc: resolvedBudget,
        userWallet: resolvedWallet,
        requestedRouteTier: resolvedRequestedRouteTier as "auto" | "easy" | "normal" | "advanced",
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);

      // Merge existing agent_trace — preserve prior payment metadata
      const { data: traceOnBrainFail } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("agent_trace")
        .eq("id", discoveryRunId)
        .single();

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: errMsg.slice(0, 500),
          agent_trace: {
            ...((traceOnBrainFail?.agent_trace as Record<string, unknown>) || {}),
            auto_tier_preflight: {
              status: "brain_failed",
              error: errMsg.slice(0, 300),
              routing_payment: paymentMeta,
            },
          },
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        {
          ok: false,
          error: `Route preflight Brain planning failed: ${errMsg}`,
          routing_payment: paymentMeta,
        },
        { status: 502 },
      );
    }

    // ── Store safe preflight result in agent_trace ──────────
    const {
      selectedTier,
      lockedQuote,
      lockedExecutionPlan,
      safeBrainFields,
      routingFeeUsdc,
      finalEntryPaymentUsdc,
      grossUserChargeUsdc,
      grossRunChargeUsdc,
      expectedInternalX402RoutingUsdc,
      } = preflightResult;

    const traceData = {
      requested_route_tier: resolvedRequestedRouteTier,
      selected_tier: selectedTier,
      routing_fee_usdc: routingFeeUsdc,
      final_entry_payment_usdc: finalEntryPaymentUsdc,
      gross_user_charge_usdc: grossUserChargeUsdc,
      gross_run_charge_usdc: grossRunChargeUsdc,
      expected_internal_x402_routing_usdc: expectedInternalX402RoutingUsdc,
      locked_planned_cost_usdc: lockedQuote.plannedCostUsdc,
      locked_planned_cost_breakdown: lockedExecutionPlan.plannedCostBreakdown,
      locked_selected_macro_nodes: lockedExecutionPlan.selectedMacroNodes,
      locked_selected_services: lockedExecutionPlan.selectedServices,
      locked_expected_payment_edges: lockedQuote.expectedPaymentEdges,
      brain_fields: safeBrainFields,
      routing_payment: paymentMeta,
      preflight_completed_at: new Date().toISOString(),
    };

    // Merge with existing agent_trace (preserve any prior data)
    const { data: traceBeforeUpdate } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("agent_trace")
      .eq("id", discoveryRunId)
      .single();

    const { error: lockPersistErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "running",
        effective_route_tier: selectedTier,
        agent_trace: {
          ...((traceBeforeUpdate?.agent_trace as Record<string, unknown>) || {}),
          auto_tier_preflight: {
            status: "locked",
            ...traceData,
          },
        },
      })
      .eq("id", discoveryRunId);

    if (lockPersistErr) {
      // Payment was settled but persist failed — report error, do not pretend success
      console.error("[route-preflight] persist failed after payment settle:", lockPersistErr.message);
      return NextResponse.json(
        {
          ok: false,
          error: `Route preflight persist failed: ${lockPersistErr.message}`,
          routing_payment: paymentMeta,
        },
        { status: 500 },
      );
    }

    // ── Return safe response ────────────────────────────────
    const response = buildRoutePreflightResponse(
      discoveryRunId,
      preflightResult,
      paymentMeta,
    );

    return NextResponse.json(response, { status: 200 });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[route-preflight] unexpected error:", errMsg.slice(0, 300));
    return NextResponse.json(
      { ok: false, error: `Route preflight failed: ${errMsg.slice(0, 200)}` },
      { status: 500 },
    );
  }
}
