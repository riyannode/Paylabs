/**
 * POST /api/paylabs/dcw/run-paid
 *
 * Execute a full paid discovery run via DCW wallet.
 * REQUIRES valid session cookie.
 *
 * This endpoint does EVERYTHING server-side:
 *   1. Auth check (session)
 *   2. Wallet lookup (session user ID)
 *   3. Budget enforcement (from DB, not client)
 *   4. Full x402 payment flow (callPaidSeller)
 *   5. Returns final result (no client retry needed)
 *
 * Body: { goal: string, routeTier?: string }
 * Returns: { ok, result, paymentMetadata }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";
import { resolvePaylabsAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";

// ─── Allowlisted internal seller URLs ────────────────────────
// Only these URLs can be called as x402 sellers.
// Never accept arbitrary URLs from the client.

function getAllowedSellerUrl(path: string): string | null {
  const { baseUrl } = resolvePaylabsAppUrl();
  if (!baseUrl) return null;

  const allowedPaths = [
    "/api/paylabs/discovery-runs/inline",
    "/api/paylabs/macro-nodes",
  ];

  // Exact match or prefix match for macro-nodes (which has [nodeName] param)
  for (const allowed of allowedPaths) {
    if (path === allowed || (allowed === "/api/paylabs/macro-nodes" && path.startsWith("/api/paylabs/macro-nodes/"))) {
      return `${baseUrl}${path}`;
    }
  }
  return null;
}

// ─── Budget constants ────────────────────────────────────────
// Server-side budget cap. Client cannot exceed this.
const MAX_BUDGET_USDC = "1.0"; // 1 USDC max per run

// ─── Allowed route tiers ─────────────────────────────────────
const ALLOWED_ROUTE_TIERS = new Set(["standard", "auto", "easy", "normal", "advanced"]);

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

    // 2. Look up DCW wallet by session user ID (NOT email from body)
    const { data: wallet } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .eq("status", "active")
      .limit(1)
      .single();

    if (!wallet?.wallet_id) {
      return NextResponse.json({ ok: false, error: "No DCW wallet. Create one first." }, { status: 400 });
    }

    // 3. Check Gateway balance before attempting payment
    const { checkGatewayBalance } = await import("@/lib/paylabs/x402/gateway-balance");
    const gwBalance = await checkGatewayBalance({ depositor: wallet.wallet_address });

    if (!gwBalance.ok || parseFloat(gwBalance.balanceUsdc || "0") <= 0) {
      return NextResponse.json({
        ok: false,
        error: "Insufficient Gateway balance. Deposit USDC to your wallet first.",
        balanceUsdc: gwBalance.balanceUsdc || "0",
      }, { status: 402 });
    }

    // 4. Resolve seller URL (allowlist only)
    const sellerPath = body.sellerPath || "/api/paylabs/discovery-runs/inline";
    const sellerUrl = getAllowedSellerUrl(sellerPath);
    if (!sellerUrl) {
      return NextResponse.json({ ok: false, error: `Seller path not allowed: ${sellerPath}` }, { status: 400 });
    }

    // 5. Validate route tier server-side
    const routeTier = body.routeTier || "standard";
    if (!ALLOWED_ROUTE_TIERS.has(routeTier)) {
      return NextResponse.json({ ok: false, error: `Invalid route tier: ${routeTier}` }, { status: 400 });
    }

    // 6. Server-side budget enforcement (always use server cap, ignore client)
    const maxAmountUsdc = MAX_BUDGET_USDC;

    // 7. Execute full paid request via DCW
    //    requirePayment=true only for paid tiers (normal/advanced).
    //    Free tiers (easy/standard/auto) may return 200 without 402.
    const PAID_TIERS = new Set(["normal", "advanced"]);
    const dcwSigner = createDcwSigner();

    const result = await callPaidSeller(dcwSigner, {
      sellerUrl,
      method: "POST",
      body: {
        goal,
        route_tier: routeTier,
        user_wallet: wallet.wallet_address,
        budget_usdc: maxAmountUsdc,
      },
      headers: {},
      buyerWalletId: wallet.wallet_id,
      buyerAgentName: "paylabs-dcw-user",
      sellerServiceName: "discovery",
      maxAmountUsdc,
      requirePayment: PAID_TIERS.has(routeTier),
    });

    // 7. Return final result (no client retry needed)
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      data: result.data,
      error: result.error,
      paymentMetadata: result.paymentMetadata,
      freeResponse: result.freeResponse,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/run-paid] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
