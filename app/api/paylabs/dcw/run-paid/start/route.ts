/**
 * POST /api/paylabs/dcw/run-paid/start
 *
 * Reserves the actual PayLabs discovery run ID before the synchronous DCW
 * paid execution begins so the chat UI can subscribe to office events live.
 *
 * This route does not sign, settle, or authorize payments. The existing
 * /api/paylabs/dcw/run-paid endpoint still performs the paid preflight and
 * execute-locked flow against this reserved discovery_run_id.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { isAutoTierPreflightEnabled } from "@/lib/paylabs/feature-flags";

export const maxDuration = 60;

const SERVER_MAX_BUDGET_USDC = 1.0;
const ALLOWED_ROUTE_TIERS = new Set(["standard", "auto", "easy", "normal", "advanced"]);

function parseBudget(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAutoTierPreflightEnabled()) {
      return NextResponse.json(
        { ok: false, error: "preflight_required: paid runs require route-preflight and execute-locked" },
        { status: 410 },
      );
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const goal = String(body.goal || "").trim();
    if (!goal) {
      return NextResponse.json({ ok: false, error: "Goal required" }, { status: 400 });
    }

    const routeTier = body.routeTier || body.route_tier || "auto";
    if (!ALLOWED_ROUTE_TIERS.has(routeTier)) {
      return NextResponse.json({ ok: false, error: `Invalid route tier: ${routeTier}` }, { status: 400 });
    }
    const normalizedRouteTier = routeTier === "standard" ? "auto" : routeTier;
    if (!["auto", "easy", "normal", "advanced"].includes(normalizedRouteTier)) {
      return NextResponse.json(
        { ok: false, error: `Unsupported route tier for preflight: ${routeTier}` },
        { status: 400 },
      );
    }

    const budgetUsdc = parseBudget(body.budgetUsdc ?? body.budget_usdc ?? body.budget);
    if (budgetUsdc > SERVER_MAX_BUDGET_USDC) {
      return NextResponse.json({ ok: false, error: `Budget exceeds server cap ${SERVER_MAX_BUDGET_USDC} USDC` }, { status: 400 });
    }
    const resolvedBudget = budgetUsdc > 0 ? budgetUsdc : 0.01;

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

    const dcwSigner = createDcwSigner();
    let normalizedWallet: string;
    try {
      normalizedWallet = (await dcwSigner.getWalletAddress(wallet.wallet_id)).toLowerCase();
      if (wallet.wallet_address?.toLowerCase() !== normalizedWallet) {
        console.warn("[dcw/run-paid/start] wallet_address mismatch (DB vs signer)", {
          db: wallet.wallet_address?.slice(0, 10),
          signer: normalizedWallet.slice(0, 10),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ ok: false, error: `Failed to resolve DCW wallet address: ${msg}` }, { status: 500 });
    }

    const now = new Date().toISOString();
    const { data: runRow, error: runErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .insert({
        goal: goal.slice(0, 2000),
        user_wallet: normalizedWallet,
        route_tier: normalizedRouteTier,
        status: "running",
        started_at: now,
        budget_usdc: resolvedBudget,
        runner_id: "dcw-run-paid-start",
        agent_trace: {
          auto_tier_preflight: {
            status: "preflight_pending",
            requested_route_tier: normalizedRouteTier,
            reserved_for_live_office: true,
          },
        },
      })
      .select("id")
      .single();

    if (runErr || !runRow?.id) {
      return NextResponse.json(
        { ok: false, error: `Failed to create discovery run: ${runErr?.message || "unknown"}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, runId: runRow.id, status: "running" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/run-paid/start] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
