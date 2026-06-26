/**
 * POST /api/paylabs/dcw/deposit-gateway
 *
 * Deposits USDC from a DCW wallet's on-chain balance into Circle Gateway,
 * making it available for x402 payments.
 *
 * Flow:
 *   1. Approve USDC spending by Gateway contract (ERC-20 approve)
 *   2. Call deposit() on Gateway contract
 *
 * REQUIRES valid session cookie (DCW auth).
 *
 * Body: { amountUsdc: number }
 * Returns: { ok, approveTxId, depositTxId, amountUsdc }
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";

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

// ─── Constants ───────────────────────────────────────────────

/** USDC on Arc Testnet */
const USDC_ADDRESS_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

/** Gateway WalletBatched contract on Arc Testnet */
const GATEWAY_CONTRACT_ARC_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// ─── Tx polling helper ───────────────────────────────────────

async function waitForTxComplete(client: any, txId: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const txResp = await client.getTransaction({ id: txId });
    const state = txResp?.data?.transaction?.state;
    if (state === "COMPLETE") return;
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`Transaction ${txId} ended in state: ${state}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Transaction ${txId} did not complete within ${maxWaitMs}ms`);
}

// ─── Handler ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const amountUsdc = Number(body.amountUsdc);
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      return NextResponse.json({ ok: false, error: "Valid amountUsdc required" }, { status: 400 });
    }

    // Look up wallet by session user ID
    const { data: wallet, error } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .eq("status", "active")
      .limit(1)
      .single();

    if (error || !wallet?.wallet_id) {
      return NextResponse.json({ ok: false, error: "No DCW wallet found" }, { status: 404 });
    }

    const client = getDcwClient();
    const amountAtomic = String(Math.round(amountUsdc * 1_000_000));

    // Step 1: Approve USDC spending by Gateway contract
    const approveResp = await client.executeContract({
      walletId: wallet.wallet_id,
      contractAddress: USDC_ADDRESS_ARC_TESTNET,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [GATEWAY_CONTRACT_ARC_TESTNET, amountAtomic],
      idempotencyKey: crypto.randomUUID(),
    });

    const approveTxId = approveResp?.data?.id;
    if (!approveTxId) {
      console.error("[dcw/deposit-gateway] Approve returned no tx id:", JSON.stringify(approveResp?.data));
      return NextResponse.json({ ok: false, error: "Approve transaction failed to initiate" }, { status: 502 });
    }

    // Wait for approve tx to confirm
    await waitForTxComplete(client, approveTxId);

    // Step 2: Call deposit() on Gateway contract
    // Gateway.deposit(depositor, amount) — deposits USDC into Gateway for x402 use
    const depositResp = await client.executeContract({
      walletId: wallet.wallet_id,
      contractAddress: GATEWAY_CONTRACT_ARC_TESTNET,
      abiFunctionSignature: "deposit(address,uint256)",
      abiParameters: [wallet.wallet_address, amountAtomic],
      idempotencyKey: crypto.randomUUID(),
    });

    const depositTxId = depositResp?.data?.id;
    if (!depositTxId) {
      console.error("[dcw/deposit-gateway] Deposit returned no tx id:", JSON.stringify(depositResp?.data));
      return NextResponse.json({
        ok: false,
        error: "Deposit transaction failed to initiate (approve succeeded)",
        approveTxId,
      }, { status: 502 });
    }

    // Wait for deposit tx to confirm
    await waitForTxComplete(client, depositTxId);

    return NextResponse.json({
      ok: true,
      approveTxId,
      depositTxId,
      amountUsdc,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/deposit-gateway] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
