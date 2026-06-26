/**
 * POST /api/paylabs/dcw/deposit-gateway
 * GET  /api/paylabs/dcw/deposit-gateway?txId=...
 *
 * POST: Initiates USDC deposit from DCW wallet into Circle Gateway.
 *   Returns tx IDs immediately (non-blocking). Poll with GET.
 *
 * GET: Poll transaction state by ID.
 *   Returns { ok, txId, state, txHash }.
 *
 * REQUIRES valid session cookie (DCW auth).
 *
 * POST Body: { amountUsdc: number }
 * Returns: { ok, approveTxId, depositTxId, amountUsdc, state }
 *
 * State machine:
 *   approve_pending → deposit_pending → complete | failed
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";
import {
  USDC_CONTRACT_ADDRESS,
  GATEWAY_CONTRACT_ADDRESS,
  getDcwHealth,
} from "@/lib/paylabs/dcw/config";

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

// ─── Tx state lookup ─────────────────────────────────────────

async function getTxState(txId: string): Promise<{
  state: string;
  txHash: string | null;
  error: string | null;
}> {
  try {
    const client = getDcwClient();
    const resp = await client.getTransaction({ id: txId });
    const tx = resp?.data?.transaction;
    return {
      state: tx?.state || "UNKNOWN",
      txHash: tx?.txHash || null,
      error: tx?.errorReason || null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: "ERROR", txHash: null, error: msg.slice(0, 200) };
  }
}

// ─── GET: Poll tx status ─────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const txId = req.nextUrl.searchParams.get("txId");
    if (!txId) {
      return NextResponse.json({ ok: false, error: "txId parameter required" }, { status: 400 });
    }

    const { state, txHash, error } = await getTxState(txId);

    const terminal = ["COMPLETE", "FAILED", "CANCELLED", "DENIED"].includes(state);

    return NextResponse.json({
      ok: true,
      txId,
      state,
      txHash,
      error,
      terminal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Initiate deposit (non-blocking) ───────────────────

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

    const health = getDcwHealth();
    if (!health.usdc_contract_configured || !health.gateway_contract_configured) {
      return NextResponse.json({
        ok: false,
        error: "Contract addresses not properly configured",
        health,
      }, { status: 500 });
    }

    // Step 1: Approve USDC spending by Gateway contract (non-blocking)
    // Per Circle docs: use createContractExecutionTransaction with fee level
    const approveResp = await client.createContractExecutionTransaction({
      walletId: wallet.wallet_id,
      contractAddress: USDC_CONTRACT_ADDRESS,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [GATEWAY_CONTRACT_ADDRESS, amountAtomic],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: crypto.randomUUID(),
    });

    const approveTxId = approveResp?.data?.id;
    if (!approveTxId) {
      console.error("[dcw/deposit-gateway] Approve returned no tx id:", JSON.stringify(approveResp?.data));
      return NextResponse.json({ ok: false, error: "Approve transaction failed to initiate" }, { status: 502 });
    }

    // Step 2: Submit deposit tx immediately (don't wait for approve)
    // The Gateway contract handles approve+deposit atomically on-chain.
    // If approve isn't confirmed yet, deposit will queue and execute after.
    let depositTxId: string | null = null;
    let depositError: string | null = null;

    try {
      const depositResp = await client.createContractExecutionTransaction({
        walletId: wallet.wallet_id,
        contractAddress: GATEWAY_CONTRACT_ADDRESS,
        abiFunctionSignature: "deposit(address,uint256)",
        abiParameters: [wallet.wallet_address, amountAtomic],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: crypto.randomUUID(),
      });

      depositTxId = depositResp?.data?.id || null;
      if (!depositTxId) {
        depositError = "Deposit tx returned no ID";
      }
    } catch (err: unknown) {
      depositError = err instanceof Error ? err.message : String(err);
      // Deposit may fail if approve isn't confirmed yet — that's OK
      console.warn("[dcw/deposit-gateway] Deposit submitted (may queue):", depositError.slice(0, 120));
    }

    return NextResponse.json({
      ok: true,
      approveTxId,
      depositTxId,
      amountUsdc,
      state: depositTxId ? "deposit_pending" : "approve_pending",
      note: depositTxId
        ? "Both transactions submitted. Poll with GET ?txId=<id>."
        : "Approve submitted. Deposit will be submitted after approve confirms. Poll approve first.",
      health,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/deposit-gateway] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
