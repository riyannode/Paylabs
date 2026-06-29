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
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";

// ─── Allowlisted internal seller URLs ────────────────────────
function getAllowedSellerUrl(path: string): string | null {
  const { baseUrl } = resolvePaylabsAppUrl();
  if (!baseUrl) return null;

  const allowedPaths = [
    "/api/paylabs/discovery-runs/inline",
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

    // 4. Resolve seller URL
    const sellerPath = "/api/paylabs/discovery-runs/inline";
    const sellerUrl = getAllowedSellerUrl(sellerPath);
    if (!sellerUrl) {
      return NextResponse.json({ ok: false, error: `Seller path not allowed: ${sellerPath}` }, { status: 500 });
    }

    // 5. Budget
    const requestedBudget = parseBudget(budgetUsdc);
    const userBudgetUsdc = requestedBudget > 0 ? requestedBudget : 0.01;
    const maxAmountUsdc = Math.min(userBudgetUsdc, SERVER_MAX_BUDGET_USDC).toFixed(6);

    // 6. Execute paid request — request-bound (synchronous)
    const dcwSigner = createDcwSigner();

    const result = await callPaidSeller(dcwSigner, {
      sellerUrl,
      method: "POST",
      body: {
        goal,
        route_tier: routeTier || "auto",
        user_wallet: wallet.wallet_address,
        budget_usdc: maxAmountUsdc,
      },
      headers: {},
      buyerWalletId: wallet.wallet_id,
      buyerAgentName: "paylabs-dcw-user",
      sellerServiceName: "discovery",
      maxAmountUsdc,
      requirePayment: true,
      recoverResultById: async (runId: string) => {
        const { data: run } = await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("id, status, final_answer, route_tier, effective_route_tier, brain_route_tier_hint, agent_trace, source_snapshot, error_summary")
          .eq("id", runId)
          .single();

        if (!run) return null;
        if (run.status !== "completed" && run.status !== "paid_path_available") return null;

        const sourceSnapshot = (run.source_snapshot as Record<string, unknown>) || {};
        const agentTrace = (run.agent_trace as Record<string, unknown>) || {};

        return {
          ok: true,
          status: "completed",
          final_answer: run.final_answer || sourceSnapshot.final_answer || agentTrace.final_answer || null,
          effective_route_tier: run.effective_route_tier || run.route_tier,
          brain_route_tier_hint: run.brain_route_tier_hint,
          source_context: sourceSnapshot.source_context || agentTrace.source_context || null,
          payment_graph: agentTrace.payment_graph || null,
          quote: agentTrace.quote || null,
          exit_output: agentTrace.exit_output || null,
          _brain_diag: agentTrace._brain_diag || null,
          _recovered: true,
          _recovery_source: "supabase_poll",
        };
      },
    });

    // 7. Build entry_payment shape
    const paymentMetadata = result.paymentMetadata ?? null;
    const resultData = result.data as Record<string, unknown> | null | undefined;
    const dataEntry = (resultData?.entry_payment as Record<string, unknown> | null | undefined) ?? null;

    const entryPayment = {
      status: result.ok ? "paid" : "failed",
      tx_hash: paymentMetadata?.txHash ?? (dataEntry?.tx_hash as string | null | undefined) ?? null,
      explorer_url: paymentMetadata?.explorerUrl ?? (dataEntry?.explorer_url as string | null | undefined) ?? null,
      settlement_id: paymentMetadata?.settlementId ?? (dataEntry?.settlement_id as string | null | undefined) ?? null,
      settlement_url: paymentMetadata?.settlementUrl ?? (dataEntry?.settlement_url as string | null | undefined) ?? null,
      transfer_status: paymentMetadata?.transferStatus ?? (dataEntry?.transfer_status as string | null | undefined) ?? null,
      gateway_accepted: paymentMetadata?.gatewayAccepted ?? (dataEntry?.gateway_accepted as boolean | undefined) ?? result.ok,
      batch_tx_hash: paymentMetadata?.batchTxHash ?? (dataEntry?.batch_tx_hash as string | null | undefined) ?? null,
      batch_explorer_url: paymentMetadata?.batchExplorerUrl ?? (dataEntry?.batch_explorer_url as string | null | undefined) ?? null,
      batch_resolver_url: paymentMetadata?.batchResolverUrl ?? (dataEntry?.batch_resolver_url as string | null | undefined) ?? null,
      customer_wallet: wallet.wallet_address,
      customer_wallet_type: "circle_developer_controlled" as const,
    };

    // 8. Return final result directly
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      data: result.data,
      error: result.error,
      paymentMetadata,
      freeResponse: result.freeResponse,
      entry_payment: entryPayment,
      entry_payment_explorer_url: entryPayment.explorer_url,
      entry_payment_batch_explorer_url: entryPayment.batch_explorer_url,
      _brain_diag: (resultData?._brain_diag as Record<string, unknown>) ?? null,
    }, { status: result.ok ? 200 : 502 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/run-paid] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
