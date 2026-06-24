/**
 * GET /api/paylabs/dcw/balance?email=... OR ?address=...
 *
 * Returns DCW wallet info + Gateway balance for a user.
 * Gateway balance = USDC available for x402 payments.
 *
 * Returns: { ok, walletId, address, gatewayBalance, walletBalance }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";

export async function GET(req: NextRequest) {
  try {
    const email = req.nextUrl.searchParams.get("email")?.trim().toLowerCase();
    const address = req.nextUrl.searchParams.get("address")?.trim().toLowerCase();

    if (!email && !address) {
      return NextResponse.json(
        { ok: false, error: "email or address query param required" },
        { status: 400 }
      );
    }

    // 1. Look up wallet in Supabase
    let query = supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address, chain, status")
      .eq("status", "active")
      .limit(1);

    if (email) {
      query = query.eq("email", email);
    } else if (address) {
      query = query.eq("wallet_address", address);
    }

    const { data: wallet, error } = await query.single();

    if (error || !wallet) {
      return NextResponse.json(
        { ok: false, error: "No DCW wallet found" },
        { status: 404 }
      );
    }

    // 2. Check Gateway balance
    const gwBalance = await checkGatewayBalance({
      depositor: wallet.wallet_address,
    });

    return NextResponse.json({
      ok: true,
      walletId: wallet.wallet_id,
      address: wallet.wallet_address,
      chain: wallet.chain,
      gateway: {
        balanceUsdc: gwBalance.balanceUsdc || "0",
        balanceAtomic: gwBalance.balanceAtomic || "0",
        pendingBatchUsdc: gwBalance.pendingBatchUsdc || "0",
        ok: gwBalance.ok,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/balance] Error:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }
}
