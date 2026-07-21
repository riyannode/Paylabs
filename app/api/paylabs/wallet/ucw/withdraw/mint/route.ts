/**
 * POST /api/paylabs/wallet/ucw/withdraw/mint — Resolve mint challenge
 * GET  /api/paylabs/wallet/ucw/withdraw/mint?withdrawalId=uuid — Poll mint status
 *
 * After browser executes sdk.execute(mintChallengeId), call this endpoint
 * to resolve the Circle transaction ID via getChallenge → correlationIds → getTransaction.
 *
 * REQUIRES valid UCW session cookie (ucw_sid).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession, getUserChallenge, getTransactionStatus } from "@/lib/paylabs/ucw";
import { getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import { explorerUrl } from "@/lib/paylabs/withdrawal/explorer";

const TERMINAL_SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const TERMINAL_FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);

// ─── Auth ────────────────────────────────────────────────────

async function getUcwSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return null;
  return getSession(sid);
}

function safeResponse(row: any) {
  return {
    withdrawalId: row.id,
    status: row.status,
    circleTransactionId: row.circle_transaction_id || null,
    txHash: row.tx_hash || null,
    explorerUrl: row.explorer_url || null,
  };
}

// ─── GET: Poll Status ────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const session = await getUcwSession(req);
    if (!session?.walletId) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    const withdrawalId = req.nextUrl.searchParams.get("withdrawalId");
    if (!withdrawalId) {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }

    const { row, error } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    if (error || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }

    // If we have a circle_transaction_id, poll it
    if (row.circle_transaction_id && session.userToken) {
      try {
        const txStatus = await getTransactionStatus(session.userToken, row.circle_transaction_id);

        if (TERMINAL_SUCCESS.has(txStatus.state)) {
          await updateWithdrawal(withdrawalId, {
            status: "finalized",
            txHash: txStatus.txHash || undefined,
            explorerUrl: explorerUrl(txStatus.txHash) || undefined,
          });
          // Re-read
          const { row: updated } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
          return NextResponse.json({ ok: true, ...safeResponse(updated || row) });
        }

        if (TERMINAL_FAILURE.has(txStatus.state)) {
          await updateWithdrawal(withdrawalId, {
            status: "failed",
            errorCode: "mint_tx_failed",
            errorMessage: `Circle mint transaction: ${txStatus.state}`,
            txHash: txStatus.txHash || undefined,
          });
          const { row: updated } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
          return NextResponse.json({ ok: true, ...safeResponse(updated || row) });
        }
      } catch {
        // Transaction polling failed — leave status as is
      }
    }

    return NextResponse.json({ ok: true, ...safeResponse(row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Resolve Mint Challenge ────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const session = await getUcwSession(req);
    if (!session?.userToken || !session.walletId) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    // 2. Parse body
    const body = await req.json().catch(() => ({}));
    const withdrawalId = body.withdrawalId;

    if (!withdrawalId || typeof withdrawalId !== "string") {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }

    // 3. Load withdrawal
    const { row, error: loadError } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    if (loadError || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }

    if (!row.mint_challenge_id) {
      return NextResponse.json({ ok: false, error: "No mint challenge to resolve" }, { status: 400 });
    }

    // 4. Resolve challenge → correlationIds → transaction ID
    try {
      const challenge = await getUserChallenge(session.userToken, row.mint_challenge_id);
      const correlationId = challenge.correlationIds?.[0];

      if (correlationId) {
        // Try to get transaction by correlation ID
        try {
          const txStatus = await getTransactionStatus(session.userToken, correlationId);
          await updateWithdrawal(withdrawalId, {
            circleTransactionId: correlationId,
          });

          if (TERMINAL_SUCCESS.has(txStatus.state)) {
            await updateWithdrawal(withdrawalId, {
              status: "finalized",
              txHash: txStatus.txHash || undefined,
              explorerUrl: explorerUrl(txStatus.txHash) || undefined,
            });
          } else if (TERMINAL_FAILURE.has(txStatus.state)) {
            await updateWithdrawal(withdrawalId, {
              status: "failed",
              errorCode: "mint_tx_failed",
              errorMessage: `Circle mint transaction: ${txStatus.state}`,
              txHash: txStatus.txHash || undefined,
            });
          }
        } catch {
          // Transaction not yet available — challenge may still be processing
        }
      }
    } catch {
      // Challenge resolution failed — leave status as mint_approval_pending
    }

    // 5. Return current status
    const { row: finalRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    return NextResponse.json({ ok: true, ...safeResponse(finalRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/withdraw/mint] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Mint resolution failed" }, { status: 500 });
  }
}
