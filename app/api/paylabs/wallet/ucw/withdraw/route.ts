/**
 * POST /api/paylabs/wallet/ucw/withdraw — Initiate UCW Gateway withdrawal
 * GET  /api/paylabs/wallet/ucw/withdraw?withdrawalId=uuid — Check withdrawal status
 *
 * UCW withdrawal flow (two-approval):
 *   POST: estimate → create sign challenge → return signChallengeId
 *   (browser executes sdk.execute(signChallengeId) → gets signature)
 *   POST /sign: receive signature → submit to Gateway → create mint challenge
 *   (browser executes sdk.execute(mintChallengeId) → mints tokens)
 *   POST /mint: resolve challenge → poll → finalize
 *
 * REQUIRES valid UCW session cookie (ucw_sid).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/ucw";
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

    return NextResponse.json({ ok: true, ...safeResponse(row) });
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
    const amountUsdc = body.amount;
    const idempotencyKey = body.idempotencyKey;

    if (!amountUsdc || typeof amountUsdc !== "string") {
      return NextResponse.json({ ok: false, error: "amount (string) required" }, { status: 400 });
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return NextResponse.json({ ok: false, error: "idempotencyKey (UUID) required" }, { status: 400 });
    }

    const walletId = session.walletId;
    const walletAddress = session.walletAddress.toLowerCase();

    // 3. Check Gateway available balance
    const gwBalance = await checkGatewayBalance({ depositor: walletAddress });
    if (!gwBalance.ok || !gwBalance.balanceAtomic) {
      return NextResponse.json({ ok: false, error: gwBalance.error || "Gateway balance unavailable" }, { status: 502 });
    }

    // 4. Validate amount
    const amountValidation = validateAmount({ amountUsdc, availableAtomic: gwBalance.balanceAtomic });
    if (!amountValidation.ok) {
      return NextResponse.json({ ok: false, error: amountValidation.error }, { status: 400 });
    }
    const amountAtomic = amountValidation.amountAtomic!;

    // 5. Build TransferSpec
    const spec = buildTransferSpec({ walletAddress, amountAtomic });

    // 6. Gateway estimate
    const estimate = await estimateGatewayWithdrawal({ spec });
    if (!estimate.ok || !estimate.burnIntent) {
      return NextResponse.json({ ok: false, error: estimate.error || "Gateway estimate failed" }, { status: 502 });
    }

    // 7. Fee cap validation
    if (estimate.gatewayFee) {
      const feeValidation = validateFeeCap({ estimatedFee: estimate.gatewayFee });
      if (!feeValidation.ok) {
        return NextResponse.json({ ok: false, error: feeValidation.error }, { status: 400 });
      }
    }

    // 8. Compute burn intent hash
    const burnIntentHash = await computeBurnIntentDigest(estimate.burnIntent);

    // 9. Store canonical BurnIntent — check for idempotent duplicate
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

    // IDEMPOTENT DUPLICATE — return existing, DO NOT create new challenge
    if (!created) {
      return NextResponse.json({ ok: true, ...safeResponse(row) });
    }

    // 10. CAS: prepared → burn_signature_pending
    const casResult = await updateWithdrawal(row.id, {
      status: "burn_signature_pending",
      expectedStatus: "prepared",
    });
    if (!casResult.ok || !casResult.row) {
      return NextResponse.json({ ok: false, error: "Concurrent modification detected" }, { status: 409 });
    }

    // 11. Create signTypedData challenge via UCW SDK
    const typedData = {
      types: GATEWAY_EIP712_TYPES,
      domain: GATEWAY_EIP712_DOMAIN,
      primaryType: "BurnIntent",
      message: estimate.burnIntent,
    };

    const { challengeId: signChallengeId } = await signTypedDataForGateway(
      session.userToken,
      walletId,
      typedData,
    );

    await updateWithdrawal(row.id, {
      signingChallengeId: signChallengeId,
      expectedStatus: "burn_signature_pending",
    });

    return NextResponse.json({
      ok: true,
      withdrawalId: row.id,
      status: "burn_signature_pending",
      signChallengeId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/withdraw] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Withdrawal initiation failed" }, { status: 500 });
  }
}
