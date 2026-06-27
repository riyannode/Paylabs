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

function parseDepositFlowId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return null;
  return trimmed;
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.slice(0, 300);
  if (value == null) return fallback;
  return String(value).slice(0, 300);
}

function extractCircleError(e: unknown) {
  const err = e as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: {
      status?: unknown;
      data?: {
        code?: unknown;
        errorCode?: unknown;
        message?: unknown;
        error?: unknown;
      };
    };
  };

  return {
    code: text(err?.code ?? err?.response?.data?.code ?? err?.response?.data?.errorCode, ""),
    status: text(err?.status ?? err?.response?.status, ""),
    message: text(err?.message ?? err?.response?.data?.message, "unknown"),
    responseMessage: text(err?.response?.data?.message ?? err?.response?.data?.error, ""),
  };
}

function shortAddress(address?: string | null): string {
  if (!address) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
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
    const rawDepositFlowId = req.nextUrl.searchParams.get("depositFlowId");
    const depositFlowId = parseDepositFlowId(rawDepositFlowId);

    if (rawDepositFlowId && !depositFlowId) {
      return NextResponse.json({ ok: false, error: "Invalid depositFlowId" }, { status: 400 });
    }

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
        reason: "Approve transaction failed.",
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
      const depositIdempotencyKey = depositFlowId
        ? `paylabs-dcw-gateway-deposit:${session.sub}:${wallet.wallet_id}:${depositFlowId}:${approveTxId}:${amountAtomic}`
        : `paylabs-dcw-gateway-deposit:${session.sub}:${wallet.wallet_id}:${approveTxId}:${amountAtomic}`;

      try {
        const depositResp = await client.createContractExecutionTransaction({
          walletId: wallet.wallet_id,
          contractAddress: GATEWAY_CONTRACT_ADDRESS,
          abiFunctionSignature: "deposit(address,uint256)",
          abiParameters: [USDC_CONTRACT_ADDRESS, amountAtomic],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: depositIdempotencyKey,
        });

        const newDepositTxId = depositResp?.data?.id;
        if (!newDepositTxId) {
          return NextResponse.json({
            ok: true,
            approveTxId,
            depositTxId: null,
            state: "failed",
            reason: "Gateway deposit transaction failed.",
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
        const safe = extractCircleError(err);

        console.error("[dcw/deposit-gateway] Deposit submission failed", {
          ...safe,
          wallet: shortAddress(wallet.wallet_address),
          chain: "ARC-TESTNET",
        });

        return NextResponse.json({
          ok: true,
          approveTxId,
          depositTxId: null,
          state: "failed",
          reason: "Gateway deposit transaction failed.",
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
        reason: "Gateway deposit transaction failed.",
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

    // Deposit tx is COMPLETE — verify Gateway balance >= expected amount
    const expectedAmount = Number(amountUsdc);

    const { data: walletForCheck } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .limit(1)
      .single();

    let balanceVerified = false;
    let gatewayBalance: string | null = null;

    if (walletForCheck?.wallet_address && Number.isFinite(expectedAmount) && expectedAmount > 0) {
      try {
        const gwBal = await checkGatewayBalance({ depositor: walletForCheck.wallet_address });
        if (gwBal.ok && gwBal.balanceUsdc) {
          gatewayBalance = gwBal.balanceUsdc;
          // Must be >= deposited amount to confirm this specific deposit landed
          balanceVerified = parseFloat(gwBal.balanceUsdc) >= expectedAmount;
        }
      } catch {
        // Balance check failed — return deposit_complete, NOT complete
        balanceVerified = false;
      }
    } else if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) {
      // amountUsdc missing or invalid — can't verify, stay at deposit_complete
      balanceVerified = false;
    } else {
      // No wallet address — can't verify, stay at deposit_complete
      balanceVerified = false;
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
    console.error("[dcw/deposit-gateway] GET error:", msg);
    return NextResponse.json({ ok: false, error: "Gateway deposit status check failed." }, { status: 500 });
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
    const rawDepositFlowId = body.depositFlowId;
    const depositFlowId = parseDepositFlowId(rawDepositFlowId);
    if (rawDepositFlowId != null && !depositFlowId) {
      return NextResponse.json({ ok: false, error: "Invalid depositFlowId" }, { status: 400 });
    }
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

    const approveIdempotencyKey = depositFlowId
      ? `paylabs-dcw-gateway-approve:${session.sub}:${wallet.wallet_id}:${depositFlowId}:${amountAtomic}`
      : `paylabs-dcw-gateway-approve:${session.sub}:${wallet.wallet_id}:${amountAtomic}`;

    // Step 1 ONLY: Approve USDC spending by Gateway contract
    // DO NOT submit deposit here — wait for approve COMPLETE via GET poll
    let approveTxId: string | undefined;
    try {
      const approveResp = await client.createContractExecutionTransaction({
        walletId: wallet.wallet_id,
        contractAddress: USDC_CONTRACT_ADDRESS,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [GATEWAY_CONTRACT_ADDRESS, amountAtomic],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: approveIdempotencyKey,
      });

      approveTxId = approveResp?.data?.id;
    } catch (e: unknown) {
      const safe = extractCircleError(e);

      console.error("[dcw/deposit-gateway] Approve submission failed", {
        ...safe,
        wallet: shortAddress(wallet.wallet_address),
        chain: "ARC-TESTNET",
      });

      return NextResponse.json(
        {
          ok: false,
          error: "Approve transaction failed.",
          reason: safe.message,
        },
        { status: 502 }
      );
    }

    if (!approveTxId) {
      console.error("[dcw/deposit-gateway] Approve returned no tx id");
      return NextResponse.json({ ok: false, error: "Approve transaction failed." }, { status: 502 });
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
    return NextResponse.json({ ok: false, error: "Approve transaction failed." }, { status: 500 });
  }
}
