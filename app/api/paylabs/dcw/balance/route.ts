/**
 * GET /api/paylabs/dcw/balance
 *
 * Returns DCW wallet info + on-chain USDC balance + Gateway balance.
 * REQUIRES valid session cookie.
 *
 * On-chain balance via Circle DCW SDK getWalletTokenBalance().
 * Gateway balance via permissionless Gateway REST API.
 *
 * Returns: { ok, walletId, address, wallet, gateway, health }
 */

import { NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";
import { getDcwHealth } from "@/lib/paylabs/dcw/config";

const _require = createRequire(import.meta.url);

// ─── Lazy DCW client init ────────────────────────────────────

let _dcwClient: any = null;

function getDcwClient() {
  if (_dcwClient) return _dcwClient;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  }
  const mod = _require("@circle-fin/developer-controlled-wallets");
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return _dcwClient;
}

// ─── On-chain Balance Fetch ──────────────────────────────────

/**
 * Fetch on-chain USDC balance for a DCW wallet.
 * Per Circle docs: use getWalletTokenBalance(), NOT getWallet().
 * Returns null values with status if fetch fails.
 */
async function fetchOnChainBalance(walletId: string): Promise<{
  usdc: string | null;
  usdcAtomic: string | null;
  walletBalanceStatus: "ok" | "unavailable";
}> {
  try {
    const client = getDcwClient();
    const balanceResp = await client.getWalletTokenBalance({ id: walletId });
    const tokenBalances = balanceResp?.data?.tokenBalances ?? [];

    // Find USDC token balance
    const usdcEntry = tokenBalances.find(
      (t: any) =>
        t.token?.symbol === "USDC" ||
        t.token?.name?.toLowerCase().includes("usdc")
    );

    if (usdcEntry) {
      const amount = usdcEntry.amount || "0";
      // amount is in human-readable format from Circle SDK
      const amountNum = parseFloat(amount);
      return {
        usdc: Number.isFinite(amountNum) ? amountNum.toFixed(6) : "0",
        usdcAtomic: Number.isFinite(amountNum)
          ? Math.round(amountNum * 1_000_000).toString()
          : "0",
        walletBalanceStatus: "ok",
      };
    }

    // No USDC token found — wallet may have 0 USDC or token not recognized
    return { usdc: "0", usdcAtomic: "0", walletBalanceStatus: "ok" };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[dcw/balance] On-chain balance fetch failed:", msg.slice(0, 120));
    return { usdc: null, usdcAtomic: null, walletBalanceStatus: "unavailable" };
  }
}

// ─── Handler ─────────────────────────────────────────────────

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

    // Fetch on-chain balance + Gateway balance in parallel
    const [onChain, gwBalance] = await Promise.all([
      fetchOnChainBalance(wallet.wallet_id),
      checkGatewayBalance({ depositor: wallet.wallet_address }),
    ]);

    const health = getDcwHealth();

    return NextResponse.json({
      ok: true,
      walletId: wallet.wallet_id,
      address: wallet.wallet_address,
      chain: wallet.chain,
      wallet: {
        usdc: onChain.usdc,
        usdcAtomic: onChain.usdcAtomic,
        walletBalanceStatus: onChain.walletBalanceStatus,
      },
      gateway: {
        balanceUsdc: gwBalance.ok ? (gwBalance.balanceUsdc || "0") : "0",
        balanceAtomic: gwBalance.ok ? (gwBalance.balanceAtomic || "0") : "0",
        pendingBatchUsdc: gwBalance.pendingBatchUsdc || "0",
        ok: gwBalance.ok,
        error: gwBalance.error || null,
      },
      health,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/balance] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
