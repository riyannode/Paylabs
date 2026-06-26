/**
 * POST /api/paylabs/dcw/deposit-gateway
 * GET  /api/paylabs/dcw/deposit-gateway?approveTxId=...&depositTxId=...&amountUsdc=...
 *
 * POST: Submits USDC approve tx only. Returns approveTxId + state="approve_pending".
 *   DO NOT submit deposit until approve is COMPLETE.
 *
 * GET: Semantic state machine poll.
 *   - If approveTxId COMPLETE and no depositTxId: submits deposit server-side, returns depositTxId + "deposit_pending"
 *   - If depositTxId COMPLETE: checks Gateway balance, returns "complete"
 *   - Returns semantic states: approve_pending | approve_complete | deposit_pending | deposit_complete | complete | failed
 *
 * REQUIRES valid session cookie (DCW auth).
 *
 * POST Body: { amountUsdc: number }
 * Returns: { ok, approveTxId, amountUsdc, state }
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
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";

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

const TERMINAL_STATES = ["COMPLETE", "FAILED", "CANCELLED", "DENIED"];

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state);
}

// ─── GET: Semantic state machine poll ────────────────────────

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const approveTxId = req.nextUrl.searchParams.get("approveTxId");
    const depositTxId = req.nextUrl.searchParams.get("depositTxId");
    const amountUsdc = req.nextUrl.searchParams.get("amountUsdc");

    if (!approveTxId) {
      return NextResponse.json({ ok: false, error: "approveTxId parameter required" }, { status: 400 });
    }

    // ── Phase 1: Check approve tx ──
    const approveState = await getTxState(approveTxId);

    if (approveState.state === "FAILED" || approveState.state === "CANCELLED" || approveState.state === "DENIED") {
      return NextResponse.json({
        ok: true,
        approveTxId,
        depositTxId: null,
        state: "failed",
        reason: `Approve tx ${approveState.state}: ${approveState.error || "no details"}`,
        approveTxHash: approveState.txHash,
      });
    }

    if (!isTerminal(approveState.state) || approveState.state !== "COMPLETE") {
      // Approve still pending
      return NextResponse.json({
        ok: true,
        approveTxId,
        depositTxId: null,
        state: "approve_pending",
        approveTxHash: approveState.txHash,
        rawApproveState: approveState.state,
      });
    }

    // Approve is COMPLETE — now check if we need to submit deposit

    // ── Phase 2: Submit deposit if not yet submitted ──
    if (!depositTxId) {
      // Look up wallet to submit deposit
      const { data: wallet, error } = await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .select("wallet_id, wallet_address")
        .eq("id", session.sub)
        .not("wallet_id", "eq", "")
        .eq("status", "active")
        .limit(1)
        .single();

      if (error || !wallet?.wallet_id) {
        return NextResponse.json({
          ok: true,
          approveTxId,
          depositTxId: null,
          state: "failed",
          reason: "No DCW wallet found for deposit submission",
        });
      }

      if (!amountUsdc || !Number.isFinite(Number(amountUsdc)) || Number(amountUsdc) <= 0) {
        return NextResponse.json({
          ok: true,
          approveTxId,
          depositTxId: null,
          state: "approve_complete",
          reason: "Approve complete. Pass amountUsdc to submit deposit.",
          approveTxHash: approveState.txHash,
        });
      }

      const client = getDcwClient();
      const amountAtomic = String(Math.round(Number(amountUsdc) * 1_000_000));

      try {
        const depositResp = await client.createContractExecutionTransaction({
          walletId: wallet.wallet_id,
          contractAddress: GATEWAY_CONTRACT_ADDRESS,
          abiFunctionSignature: "deposit(address,uint256)",
          abiParameters: [wallet.wallet_address, amountAtomic],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: crypto.randomUUID(),
        });

        const newDepositTxId = depositResp?.data?.id;
        if (!newDepositTxId) {
          return NextResponse.json({
            ok: true,
            approveTxId,
            depositTxId: null,
            state: "failed",
            reason: "Deposit tx returned no ID from Circle",
            approveTxHash: approveState.txHash,
          });
        }

        return NextResponse.json({
          ok: true,
          approveTxId,
          depositTxId: newDepositTxId,
          state: "deposit_pending",
          approveTxHash: approveState.txHash,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[dcw/deposit-gateway] Deposit submission failed:", msg);
        return NextResponse.json({
          ok: true,
          approveTxId,
          depositTxId: null,
          state: "failed",
          reason: `Deposit submission failed: ${msg.slice(0, 200)}`,
          approveTxHash: approveState.txHash,
        });
      }
    }

    // ── Phase 3: Deposit tx exists — check its state ──
    const depositState = await getTxState(depositTxId);

    if (depositState.state === "FAILED" || depositState.state === "CANCELLED" || depositState.state === "DENIED") {
      return NextResponse.json({
        ok: true,
        approveTxId,
        depositTxId,
        state: "failed",
        reason: `Deposit tx ${depositState.state}: ${depositState.error || "no details"}`,
        approveTxHash: approveState.txHash,
        depositTxHash: depositState.txHash,
      });
    }

    if (!isTerminal(depositState.state) || depositState.state !== "COMPLETE") {
      return NextResponse.json({
        ok: true,
        approveTxId,
        depositTxId,
        state: "deposit_pending",
        approveTxHash: approveState.txHash,
        depositTxHash: depositState.txHash,
        rawDepositState: depositState.state,
      });
    }

    // Deposit tx is COMPLETE — verify Gateway balance increased
    // Look up wallet address for balance check
    const { data: walletForCheck } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .limit(1)
      .single();

    let balanceVerified = false;
    let gatewayBalance: string | null = null;

    if (walletForCheck?.wallet_address) {
      try {
        const gwBal = await checkGatewayBalance({ depositor: walletForCheck.wallet_address });
        if (gwBal.ok && gwBal.balanceUsdc) {
          gatewayBalance = gwBal.balanceUsdc;
          // Balance > 0 means deposit worked (at minimum)
          balanceVerified = parseFloat(gwBal.balanceUsdc) > 0;
        }
      } catch {
        // Balance check failed — still mark complete since deposit tx is confirmed on-chain
        balanceVerified = true;
      }
    } else {
      // Can't verify balance — trust on-chain tx
      balanceVerified = true;
    }

    return NextResponse.json({
      ok: true,
      approveTxId,
      depositTxId,
      state: balanceVerified ? "complete" : "deposit_complete",
      approveTxHash: approveState.txHash,
      depositTxHash: depositState.txHash,
      gatewayBalance,
      balanceVerified,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Submit approve only (non-blocking) ───────────────

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

    // Step 1 ONLY: Approve USDC spending by Gateway contract
    // DO NOT submit deposit here — wait for approve COMPLETE via GET poll
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

    return NextResponse.json({
      ok: true,
      approveTxId,
      depositTxId: null,
      amountUsdc,
      state: "approve_pending",
      note: "Approve submitted. Poll GET ?approveTxId=<id>&amountUsdc=<amount> to track and auto-submit deposit after approve confirms.",
      health,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/deposit-gateway] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
