/**
 * GET /api/paylabs/dcw/balance
 *
 * Returns DCW wallet info + Gateway balance for the authenticated user.
 * REQUIRES valid session cookie.
 *
 * Returns: { ok, walletId, address, gateway }
 */

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";

export async function GET() {
  try {
    // Auth required
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    // Look up wallet by session user ID
    const { data: wallet, error } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address, chain")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .limit(1)
      .single();

    if (error || !wallet?.wallet_id) {
      return NextResponse.json({ ok: false, error: "No DCW wallet found" }, { status: 404 });
    }

    // Check Gateway balance
    const gwBalance = await checkGatewayBalance({ depositor: wallet.wallet_address });

    return NextResponse.json({
      ok: true,
      walletId: wallet.wallet_id,
      address: wallet.wallet_address,
      chain: wallet.chain,
      wallet: {
        usdc: null,       // DCW on-chain wallet balance not fetched yet
        usdcAtomic: null,
      },
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
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
