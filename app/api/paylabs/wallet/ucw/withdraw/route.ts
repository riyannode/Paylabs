/**
 * POST /api/paylabs/wallet/ucw/withdraw — Initiate UCW Gateway withdrawal
 * GET  /api/paylabs/wallet/ucw/withdraw?withdrawalId=uuid — Check withdrawal status
 *
 * REQUIRES valid UCW session cookie (ucw_sid).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession, refreshSession } from "@/lib/paylabs/ucw";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";
import { buildTransferSpec } from "@/lib/paylabs/withdrawal/burn-intent";
import { estimateGatewayWithdrawal } from "@/lib/paylabs/withdrawal/gateway-estimate";
import { signTypedDataForGateway } from "@/lib/paylabs/ucw";
import { computeBurnIntentDigest } from "@/lib/paylabs/withdrawal/gateway-transfer";
import { validateAmount, validateFeeCap } from "@/lib/paylabs/withdrawal/validate";
import { createWithdrawal, getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import { GATEWAY_EIP712_DOMAIN, GATEWAY_EIP712_TYPES } from "@/lib/paylabs/withdrawal/gateway-types";

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
    signChallengeId: row.signing_challenge_id || null,
    mintChallengeId: row.mint_challenge_id || null,
    circleTransactionId: row.circle_transaction_id || null,
    txHash: row.tx_hash || null,
    explorerUrl: row.explorer_url || null,
  };
}

// ─── GET: Status ─────────────────────────────────────────────

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

    await refreshSession(req.cookies.get("ucw_sid")!.value);
    const response = NextResponse.json(safeResponse(row));
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return response;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Initiate Withdrawal ───────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const session = await getUcwSession(req);
    if (!session?.userToken || !session.walletId || !session.walletAddress) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    // 2. Parse body
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const withdrawalId = body.withdrawalId;
    const amountUsdc = body.amount;
    const idempotencyKey = body.idempotencyKey;

    const walletId = session.walletId;
    const walletAddress = session.walletAddress.toLowerCase();

    if (action === "recover-sign-challenge") {
      if (!withdrawalId || typeof withdrawalId !== "string") {
        return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
      }

      const { row, error: loadError } = await getWithdrawal(withdrawalId, "creator_ucw", walletId);
      if (loadError || !row) {
        return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
      }

      if (row.status !== "burn_signature_pending") {
        await refreshSession(req.cookies.get("ucw_sid")!.value);
        const response = NextResponse.json({ ok: true, ...safeResponse(row) });
        response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
        return response;
      }
      if (!row.burn_intent || !row.burn_intent_hash) {
        return NextResponse.json({ ok: false, error: "Missing stored BurnIntent" }, { status: 500 });
      }
      if (computeBurnIntentDigest(row.burn_intent) !== row.burn_intent_hash) {
        return NextResponse.json({ ok: false, error: "BurnIntent integrity check failed" }, { status: 500 });
      }

      const typedData = {
        types: GATEWAY_EIP712_TYPES,
        domain: GATEWAY_EIP712_DOMAIN,
        primaryType: "BurnIntent",
        message: row.burn_intent,
      };
      const { challengeId } = await signTypedDataForGateway(session.userToken, walletId, typedData);
      const updated = await updateWithdrawal(row.id, {
        signingChallengeId: challengeId,
        expectedStatus: "burn_signature_pending",
      });
      if (!updated.ok || !updated.row) {
        const { row: fresh } = await getWithdrawal(withdrawalId, "creator_ucw", walletId);
        await refreshSession(req.cookies.get("ucw_sid")!.value);
        const response = NextResponse.json({ ok: true, ...safeResponse(fresh || row) });
        response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
        return response;
      }

      await refreshSession(req.cookies.get("ucw_sid")!.value);
      const response = NextResponse.json({ ok: true, ...safeResponse(updated.row) });
      response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
      return response;
    }

    if (!amountUsdc || typeof amountUsdc !== "string") {
      return NextResponse.json({ ok: false, error: "amount (string) required" }, { status: 400 });
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return NextResponse.json({ ok: false, error: "idempotencyKey (UUID) required" }, { status: 400 });
    }

    // 3. EARLY IDEMPOTENCY CHECK — before balance/estimate
    {
      const db = supabaseAdmin();
      const { data: existing } = await db
        .from("paylabs_gateway_withdrawals")
        .select("*")
        .eq("wallet_mode", "creator_ucw")
        .eq("wallet_id", walletId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existing) {
        // If existing row is burn_signature_pending with no challenge, recreate challenge
        if (existing.status === "burn_signature_pending" && !existing.signing_challenge_id) {
          const typedData = {
            types: GATEWAY_EIP712_TYPES,
            domain: GATEWAY_EIP712_DOMAIN,
            primaryType: "BurnIntent",
            message: existing.burn_intent,
          };
          try {
            const { challengeId } = await signTypedDataForGateway(session.userToken, walletId, typedData);
            await updateWithdrawal(existing.id, { signingChallengeId: challengeId, expectedStatus: "burn_signature_pending" });
            return NextResponse.json({ ok: true, ...safeResponse({ ...existing, signing_challenge_id: challengeId, status: "burn_signature_pending" }) });
          } catch {
            // Challenge recreation failed — return existing as-is, frontend can retry
            return NextResponse.json({ ok: true, ...safeResponse(existing) });
          }
        }
        return NextResponse.json({ ok: true, ...safeResponse(existing) });
      }
    }

    // 4. Check Gateway available balance
    const gwBalance = await checkGatewayBalance({ depositor: walletAddress });
    if (!gwBalance.ok || !gwBalance.balanceAtomic) {
      return NextResponse.json({ ok: false, error: gwBalance.error || "Gateway balance unavailable" }, { status: 502 });
    }

    // 5. Validate amount
    const amountValidation = validateAmount({ amountUsdc, availableAtomic: gwBalance.balanceAtomic });
    if (!amountValidation.ok) {
      return NextResponse.json({ ok: false, error: amountValidation.error }, { status: 400 });
    }
    const amountAtomic = amountValidation.amountAtomic!;

    // 6. Build TransferSpec + estimate
    const spec = buildTransferSpec({ walletAddress, amountAtomic });
    const estimate = await estimateGatewayWithdrawal({ spec });
    if (!estimate.ok || !estimate.burnIntent) {
      return NextResponse.json({ ok: false, error: estimate.error || "Gateway estimate failed" }, { status: 502 });
    }

    // 7. Fee cap
    if (estimate.gatewayFee) {
      const feeValidation = validateFeeCap({ estimatedFee: estimate.gatewayFee });
      if (!feeValidation.ok) {
        return NextResponse.json({ ok: false, error: feeValidation.error }, { status: 400 });
      }
    }

    // 8. Store canonical BurnIntent
    const burnIntentHash = computeBurnIntentDigest(estimate.burnIntent);
    const { created, row, error: createError } = await createWithdrawal({
      walletMode: "creator_ucw",
      ownerRef: walletId,
      walletId,
      walletAddress,
      amountAtomic,
      amountUsdc: parseFloat(amountUsdc),
      idempotencyKey,
      burnIntent: estimate.burnIntent,
      burnIntentHash,
      transferSpecHash: estimate.transferSpecHash || null,
      gatewayFee: estimate.gatewayFee || null,
      gatewayExpiration: estimate.gatewayExpiration || null,
    });

    if (createError || !row) {
      return NextResponse.json({ ok: false, error: createError || "Failed to create withdrawal" }, { status: 500 });
    }
    if (!created) {
      return NextResponse.json({ ok: true, ...safeResponse(row) });
    }

    // 9. CAS: prepared → burn_signature_pending
    const cas1 = await updateWithdrawal(row.id, { status: "burn_signature_pending", expectedStatus: "prepared" });
    if (!cas1.ok || !cas1.row) {
      return NextResponse.json({ ok: false, error: "Concurrent modification" }, { status: 409 });
    }

    // 10. Create signTypedData challenge — on failure, CAS back to failed
    const typedData = {
      types: GATEWAY_EIP712_TYPES,
      domain: GATEWAY_EIP712_DOMAIN,
      primaryType: "BurnIntent",
      message: estimate.burnIntent,
    };

    try {
      const { challengeId: signChallengeId } = await signTypedDataForGateway(session.userToken, walletId, typedData);

      const cas2 = await updateWithdrawal(row.id, {
        signingChallengeId: signChallengeId,
        expectedStatus: "burn_signature_pending",
      });
      if (!cas2.ok || !cas2.row) {
        return NextResponse.json({ ok: false, error: "Concurrent modification" }, { status: 409 });
      }

      return NextResponse.json({ ok: true, withdrawalId: row.id, status: "burn_signature_pending", signChallengeId });
    } catch (e: unknown) {
      // Challenge creation failed — CAS back to failed, allow retry
      const msg = e instanceof Error ? e.message : String(e);
      const casFail = await updateWithdrawal(row.id, {
        status: "failed",
        expectedStatus: "burn_signature_pending",
        errorCode: "sign_challenge_failed",
        errorMessage: msg.slice(0, 300),
      });
      if (!casFail.ok) console.error("[ucw/withdraw] CAS failed after challenge error:", casFail.error);
      return NextResponse.json({ ok: false, error: "Signing challenge creation failed" }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/withdraw] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Withdrawal initiation failed" }, { status: 500 });
  }
}
