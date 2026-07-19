/**
 * POST /api/paylabs/dcw/run-paid
 *
 * Synchronous request-bound paid discovery run via DCW wallet.
 * Executes the full x402 buyer→seller flow within the HTTP request lifecycle.
 * No jobId, no async polling, no in-memory state.
 *
 * REQUIRES valid session cookie.
 *
 * Body: { goal: string, routeTier?: string, budgetUsdc?: number }
 * Returns: { ok, status, data, error, paymentMetadata, freeResponse,
 *            entry_payment, entry_payment_explorer_url,
 *            entry_payment_batch_explorer_url }
 */

export const maxDuration = 300; // safety margin for x402 handshake

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";

// ─── Allowlisted internal seller URLs ────────────────────────
function getAllowedSellerUrl(path: string): string | null {
  const { baseUrl } = resolvePaylabsAppUrl();
  if (!baseUrl) return null;

  const allowedPaths = [
    "/api/paylabs/discovery-runs/route-preflight",
    "/api/paylabs/discovery-runs/execute-locked",
    "/api/paylabs/macro-nodes",
  ];

  for (const allowed of allowedPaths) {
    if (path === allowed || (allowed === "/api/paylabs/macro-nodes" && path.startsWith("/api/paylabs/macro-nodes/"))) {
      return `${baseUrl}${path}`;
    }
  }
  return null;
}

// ─── Budget constants ────────────────────────────────────────
const SERVER_MAX_BUDGET_USDC = 1.0;
const ALLOWED_ROUTE_TIERS = new Set(["standard", "auto", "easy", "normal", "advanced"]);

function parseBudget(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function POST(req: NextRequest) {
  try {
    // 1. Auth required
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const reservedDiscoveryRunId = String(body.discovery_run_id || body.run_id || "").trim();
    const goal = (body.goal || "").trim();
    if (!goal) {
      return NextResponse.json({ ok: false, error: "Goal required" }, { status: 400 });
    }

    const routeTier = body.routeTier || "auto";
    if (!ALLOWED_ROUTE_TIERS.has(routeTier)) {
      return NextResponse.json({ ok: false, error: `Invalid route tier: ${routeTier}` }, { status: 400 });
    }

    const budgetUsdc = parseBudget(body.budgetUsdc ?? body.budget_usdc ?? body.budget);
    if (budgetUsdc > SERVER_MAX_BUDGET_USDC) {
      return NextResponse.json({ ok: false, error: `Budget exceeds server cap ${SERVER_MAX_BUDGET_USDC} USDC` }, { status: 400 });
    }

    // 2. Look up active DCW wallet
    const { data: wallet, error: walletErr } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .eq("status", "active")
      .limit(1)
      .single();

    if (walletErr || !wallet?.wallet_id) {
      return NextResponse.json({ ok: false, error: "No DCW wallet. Create one first." }, { status: 404 });
    }

    // 3. Check Gateway balance
    const { checkGatewayBalance } = await import("@/lib/paylabs/x402/gateway-balance");
    const gwBalance = await checkGatewayBalance({ depositor: wallet.wallet_address });

    if (!gwBalance.ok) {
      return NextResponse.json(
        { ok: false, error: `Gateway balance check failed: ${gwBalance.error || "unknown"}. Retry in a moment.` },
        { status: 503 },
      );
    }

    if (parseFloat(gwBalance.balanceUsdc || "0") <= 0) {
      return NextResponse.json(
        { ok: false, error: "Insufficient Gateway balance. Deposit USDC to your wallet first." },
        { status: 402 },
      );
    }

    // 4. Create DCW signer + resolve actual wallet address (triple-match)
    const dcwSigner = createDcwSigner();
    let normalizedWallet: string;
    try {
      const signerAddress = await dcwSigner.getWalletAddress(wallet.wallet_id);
      normalizedWallet = signerAddress.toLowerCase();
      // Safe diagnostic: log if DB address differs from signer address
      if (wallet.wallet_address?.toLowerCase() !== normalizedWallet) {
        console.warn("[dcw/run-paid] wallet_address mismatch (DB vs signer)", {
          db: wallet.wallet_address?.slice(0, 10),
          signer: normalizedWallet.slice(0, 10),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: `Failed to resolve DCW wallet address: ${msg}` }, { status: 500 });
    }

    // 5. Budget
    const requestedBudget = parseBudget(budgetUsdc);
    const userBudgetUsdc = requestedBudget > 0 ? requestedBudget : 0.01;
    const maxAmountUsdc = Math.min(userBudgetUsdc, SERVER_MAX_BUDGET_USDC).toFixed(6);

    // ─── Preflight-only: all future paid runs ──────────────
    const normalizedRouteTier = routeTier === "standard" ? "auto" : routeTier;

    if (!isAutoTierPreflightEnabled()) {
      return NextResponse.json(
        { ok: false, error: "preflight_required: paid runs require route-preflight and execute-locked" },
        { status: 410 },
      );
    }

    if (!["auto", "easy", "normal", "advanced"].includes(normalizedRouteTier)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported route tier for preflight: ${routeTier}` },
        { status: 400 },
      );
    }

    // All future paid runs go through route-preflight → execute-locked.
    // auto: Brain selects tier. explicit easy/normal/advanced: preflight locks requested tier.
    {
      // Step 1: Route-preflight (0.000001 USDC)
      const preflightSellerPath = "/api/paylabs/discovery-runs/route-preflight";
      const preflightSellerUrl = getAllowedSellerUrl(preflightSellerPath);
      if (!preflightSellerUrl) {
        return NextResponse.json({ ok: false, error: `Seller path not allowed: ${preflightSellerPath}` }, { status: 500 });
      }

      const preflightResult = await callPaidSeller(dcwSigner, {
        sellerUrl: preflightSellerUrl,
        method: "POST",
        body: {
          goal,
          user_wallet: normalizedWallet,
          budget_usdc: maxAmountUsdc,
          route_tier: normalizedRouteTier,
          routeTier: normalizedRouteTier,
          discovery_run_id: reservedDiscoveryRunId || undefined,
          run_id: reservedDiscoveryRunId || undefined,
        },
        headers: {},
        buyerWalletId: wallet.wallet_id,
        buyerAgentName: "paylabs-dcw-user",
        sellerServiceName: "discovery",
        maxAmountUsdc: "0.000001", // routing fee cap only
        requirePayment: true,
        recoverResultById: async (runId: string) => {
          const { data: run } = await supabaseAdmin()
            .from("paylabs_discovery_runs")
            .select("id, status, agent_trace, effective_route_tier")
            .eq("id", runId)
            .single();
          if (!run) return null;
          const trace = (run.agent_trace as Record<string, unknown>) || {};
          const pf = trace.auto_tier_preflight as Record<string, unknown> | undefined;
          if (!pf || pf.status !== "locked") return null;
          // Fail-closed: final_entry_payment_usdc must be present and finite
          const recoveredFinalPayment = Number(pf.final_entry_payment_usdc);
          if (!Number.isFinite(recoveredFinalPayment) || recoveredFinalPayment <= 0) return null;
          return {
            ok: true,
            status: "route_preflight_locked",
            discovery_run_id: run.id,
            selected_tier: pf.selected_tier || run.effective_route_tier,
            routing_fee_usdc: pf.routing_fee_usdc,
            final_entry_payment_usdc: pf.final_entry_payment_usdc,
            locked_quote: {
              plannedCostUsdc: pf.locked_planned_cost_usdc,
              expectedPaymentEdges: pf.locked_expected_payment_edges,
              plannedCostBreakdown: pf.locked_planned_cost_breakdown,
            },
            locked_execution_plan: {
              selectedMacroNodes: pf.locked_selected_macro_nodes,
              selectedServices: pf.locked_selected_services,
            },
            safe_brain_fields: pf.brain_fields,
            routing_payment: pf.routing_payment,
          };
        },
      });

      if (!preflightResult.ok) {
        return NextResponse.json({
          ok: false,
          status: "preflight_failed",
          error: preflightResult.error || "Route preflight failed",
          paymentMetadata: preflightResult.paymentMetadata ?? null,
        }, { status: preflightResult.status === 402 ? 402 : 502 });
      }

      const preflightData = preflightResult.data as Record<string, unknown>;
      const discoveryRunId = (preflightData.discovery_run_id as string) || reservedDiscoveryRunId;
      const finalEntryPaymentUsdc = Number(preflightData.final_entry_payment_usdc);
      // Fail-closed guard: final_entry_payment_usdc must be finite and positive
      if (!Number.isFinite(finalEntryPaymentUsdc) || finalEntryPaymentUsdc <= 0) {
        return NextResponse.json(
          { ok: false, error: "invalid_preflight_final_entry_payment" },
          { status: 502 },
        );
      }
      // CORRECTION: maxAmount for execute-locked = final_entry_payment, NOT budget cap
      const finalMaxAmountUsdc = finalEntryPaymentUsdc.toFixed(6);

      // Step 2: Execute-locked (final entry payment)
      const lockedSellerPath = "/api/paylabs/discovery-runs/execute-locked";
      const lockedSellerUrl = getAllowedSellerUrl(lockedSellerPath);
      if (!lockedSellerUrl) {
        return NextResponse.json({ ok: false, error: `Seller path not allowed: ${lockedSellerPath}` }, { status: 500 });
      }

      const lockedResult = await callPaidSeller(dcwSigner, {
        sellerUrl: lockedSellerUrl,
        method: "POST",
        body: {
          discovery_run_id: discoveryRunId,
          run_id: discoveryRunId,
          user_wallet: normalizedWallet,
          budget_usdc: maxAmountUsdc,
        },
        headers: {},
        buyerWalletId: wallet.wallet_id,
        buyerAgentName: "paylabs-dcw-user",
        sellerServiceName: "discovery",
        maxAmountUsdc: finalMaxAmountUsdc, // locked amount, not budget cap
        requirePayment: true,
        recoverResultById: async (runId: string) => {
          const { data: run } = await supabaseAdmin()
            .from("paylabs_discovery_runs")
            .select("id, status, final_answer, route_tier, effective_route_tier, brain_route_tier_hint, user_wallet, agent_trace, source_snapshot, error_summary, receipt_ready, entry_payment_status, entry_payment_amount_usdc, entry_payment_tx_hash, entry_payment_explorer_url, entry_payment_settlement_id, entry_payment_batch_tx_hash, entry_payment_batch_explorer_url")
            .eq("id", runId)
            .single();
          if (!run) return null;
          if (run.status !== "completed" && run.status !== "paid_path_available") return null;
          const sourceSnapshot = (run.source_snapshot as Record<string, unknown>) || {};
          const agentTrace = (run.agent_trace as Record<string, unknown>) || {};

          // ── Preflight trace data ──
          const pf = agentTrace.auto_tier_preflight as Record<string, unknown> | undefined;
          const ex = agentTrace.auto_tier_execution as Record<string, unknown> | undefined;
          const routingPayment = (pf?.routing_payment as Record<string, unknown>) || null;
          const finalPaymentMeta = (ex?.final_payment as Record<string, unknown>) || null;

          // ── Reconstruct entry_payment with full metadata parity ──
          // Source: DB columns → agent_trace.auto_tier_execution.final_payment → fallback
          const entryPayment = {
            status: run.entry_payment_status || "paid",
            amount_usdc: run.entry_payment_amount_usdc || pf?.final_entry_payment_usdc || null,
            tx_hash: run.entry_payment_tx_hash || (finalPaymentMeta?.tx_hash as string) || null,
            explorer_url: run.entry_payment_explorer_url || (finalPaymentMeta?.explorer_url as string) || null,
            settlement_id: run.entry_payment_settlement_id || (finalPaymentMeta?.settlement_id as string) || null,
            settlement_url: (finalPaymentMeta?.settlement_url as string) || null,
            batch_tx_hash: run.entry_payment_batch_tx_hash || (finalPaymentMeta?.batch_tx_hash as string) || null,
            batch_explorer_url: run.entry_payment_batch_explorer_url || (finalPaymentMeta?.batch_explorer_url as string) || null,
            batch_resolver_url: (finalPaymentMeta?.batch_resolver_url as string) || null,
            gateway_accepted: (finalPaymentMeta?.gateway_accepted as boolean) ?? true,
            transfer_status: (finalPaymentMeta?.transfer_status as string) || null,
            customer_wallet: run.user_wallet || null,
            customer_wallet_type: "circle_developer_controlled" as const,
          };

          // ── Reconstruct locked_execution_plan from preflight trace ──
          const lockedExecutionPlan = pf
            ? {
                selected_macro_nodes: (pf.locked_selected_macro_nodes as string[]) || [],
                selected_services: (pf.locked_selected_services as string[]) || [],
                planned_cost_usdc: (pf.locked_planned_cost_usdc as number) || 0,
                planned_cost_breakdown: pf.locked_planned_cost_breakdown || {
                  brain_treasury_usdc: 0,
                  macro_node_fees_usdc: 0,
                  service_edge_fees_usdc: 0,
                  registry_check_fees_usdc: 0,
                  source_access_fees_usdc: 0,
                },
                locked: true,
              }
            : null;

          // ── Compute user_cost_usdc ──
          const routingFeeUsdc = Number(pf?.routing_fee_usdc) || 0;
          const finalEntryUsdc = Number(pf?.final_entry_payment_usdc) || 0;
          const userCostUsdc = routingFeeUsdc + finalEntryUsdc;

          return {
            ok: true,
            status: "completed",
            discovery_run_id: run.id,
            final_answer: run.final_answer || sourceSnapshot.final_answer || agentTrace.final_answer || null,
            brain_planning: agentTrace.brain_planning || null,
            _brain_diag: agentTrace._brain_diag || null,
            effective_route_tier: run.effective_route_tier || run.route_tier,
            route_tier: run.effective_route_tier || run.route_tier,
            brain_route_tier_hint: run.brain_route_tier_hint,
            requested_route_tier: (pf?.requested_route_tier as string) || "auto",
            locked_execution_plan: lockedExecutionPlan,
            execution_origin: (agentTrace.execution_origin as string) || "vercel_execute_locked",
            execution_mode: (agentTrace.execution_mode as string) || "x402_locked_orchestration",
            worker_used: false,
            x402_enabled: true,
            phases_completed: agentTrace.phases_completed || null,
            preflight_routing_payment: routingPayment,
            final_entry_payment: finalPaymentMeta,
            user_cost_usdc: userCostUsdc,
            payment_plan: agentTrace.payment_plan || null,
            payment_graph: agentTrace.payment_graph || null,
            safe_progress_summaries: agentTrace.safe_progress_summaries || null,
            budget_snapshot: agentTrace.budget_snapshot || null,
            tiered_summaries: agentTrace.tiered_summaries || null,
            source_context: sourceSnapshot.source_context || agentTrace.source_context || null,
            source_context_error: agentTrace.source_context_error || null,
            quote: agentTrace.quote || null,
            exit_output: agentTrace.exit_output || null,
            entry_payment: entryPayment,
            entry_payment_explorer_url: entryPayment.explorer_url,
            entry_payment_batch_explorer_url: entryPayment.batch_explorer_url,
            entry_payment_settlement_id: entryPayment.settlement_id,
            entry_payment_batch_resolver_url: entryPayment.batch_resolver_url,
            receipt_ready: run.receipt_ready ?? true,
            settled: run.status === "completed" || run.status === "paid_path_available",
            mode: "x402",
            error: run.error_summary || null,
            visibility_error: null,
            _recovered: true,
            _recovery_source: "supabase_poll",
          };
        },
      });

      // Build entry_payment shape from locked result
      const lockedPaymentMetadata = lockedResult.paymentMetadata ?? null;
      const lockedResultData = lockedResult.data as Record<string, unknown> | null | undefined;
      const lockedDataEntry = (lockedResultData?.entry_payment as Record<string, unknown> | null | undefined) ?? null;

      const lockedEntryPayment = {
        status: lockedResult.ok ? "paid" : "failed",
        tx_hash: lockedPaymentMetadata?.txHash ?? (lockedDataEntry?.tx_hash as string | null | undefined) ?? null,
        explorer_url: lockedPaymentMetadata?.explorerUrl ?? (lockedDataEntry?.explorer_url as string | null | undefined) ?? null,
        settlement_id: lockedPaymentMetadata?.settlementId ?? (lockedDataEntry?.settlement_id as string | null | undefined) ?? null,
        settlement_url: lockedPaymentMetadata?.settlementUrl ?? (lockedDataEntry?.settlement_url as string | null | undefined) ?? null,
        transfer_status: lockedPaymentMetadata?.transferStatus ?? (lockedDataEntry?.transfer_status as string | null | undefined) ?? null,
        gateway_accepted: lockedPaymentMetadata?.gatewayAccepted ?? (lockedDataEntry?.gateway_accepted as boolean | undefined) ?? lockedResult.ok,
        batch_tx_hash: lockedPaymentMetadata?.batchTxHash ?? (lockedDataEntry?.batch_tx_hash as string | null | undefined) ?? null,
        batch_explorer_url: lockedPaymentMetadata?.batchExplorerUrl ?? (lockedDataEntry?.batch_explorer_url as string | null | undefined) ?? null,
        batch_resolver_url: lockedPaymentMetadata?.batchResolverUrl ?? (lockedDataEntry?.batch_resolver_url as string | null | undefined) ?? null,
        customer_wallet: normalizedWallet,
        customer_wallet_type: "circle_developer_controlled" as const,
      };

      return NextResponse.json({
        ok: lockedResult.ok,
        status: lockedResult.status,
        data: lockedResult.data,
        error: lockedResult.error,
        paymentMetadata: lockedPaymentMetadata,
        freeResponse: lockedResult.freeResponse,
        entry_payment: lockedEntryPayment,
        entry_payment_explorer_url: lockedEntryPayment.explorer_url,
        entry_payment_batch_explorer_url: lockedEntryPayment.batch_explorer_url,
      }, { status: lockedResult.ok ? 200 : 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/run-paid] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
