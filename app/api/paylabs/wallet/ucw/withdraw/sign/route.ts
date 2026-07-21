/**
 * POST /api/paylabs/wallet/ucw/withdraw/sign — Submit user signature
 *
 * Receives the EIP-712 signature from the browser (after sdk.execute(signChallengeId)),
 * loads the canonical BurnIntent from DB, submits to Gateway, and creates the mint challenge.
 *
 * Request: { withdrawalId, signature }
 * Response: { withdrawalId, status, mintChallengeId }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/ucw";
import { submitGatewayTransfer, keccak256Json } from "@/lib/paylabs/withdrawal/gateway-transfer";
import { createGatewayMintChallenge } from "@/lib/paylabs/ucw";
import { getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";

// ─── Auth ────────────────────────────────────────────────────

async function getUcwSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return null;
  return getSession(sid);
}

// ─── POST ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const session = await getUcwSession(req);
    if (!session?.userToken || !session.walletId) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    // 2. Parse body — ONLY withdrawalId and signature
    const body = await req.json().catch(() => ({}));
    const withdrawalId = body.withdrawalId;
    const signature = body.signature;

    if (!withdrawalId || typeof withdrawalId !== "string") {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string") {
      return NextResponse.json({ ok: false, error: "signature required" }, { status: 400 });
    }

    // Reject any additional fields that should not be sent
    const allowedFields = new Set(["withdrawalId", "signature"]);
    for (const key of Object.keys(body)) {
      if (!allowedFields.has(key)) {
        return NextResponse.json({ ok: false, error: `Unexpected field: ${key}` }, { status: 400 });
      }
    }

    // 3. Load withdrawal and verify ownership
    const { row, error: loadError } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    if (loadError || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }

    if (row.status !== "burn_signature_pending") {
      return NextResponse.json({ ok: false, error: `Invalid status: ${row.status}. Expected: burn_signature_pending` }, { status: 400 });
    }

    // 4. Load canonical BurnIntent from DB
    const burnIntent = row.burn_intent;
    if (!burnIntent || !burnIntent.spec) {
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "missing_burn_intent", errorMessage: "Canonical BurnIntent not found in DB" });
      return NextResponse.json({ ok: false, error: "Internal error: BurnIntent missing" }, { status: 500 });
    }

    // 5. Verify destination matches authenticated wallet
    const expectedRecipient = "0x" + session.walletAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (burnIntent.spec.destinationRecipient !== expectedRecipient) {
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "destination_mismatch", errorMessage: "Destination does not match wallet" });
      return NextResponse.json({ ok: false, error: "Destination mismatch" }, { status: 403 });
    }

    // 6. Submit to Gateway
    const transferResult = await submitGatewayTransfer({ burnIntent, signature });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        await updateWithdrawal(withdrawalId, { status: "reconciliation_required", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "gateway_transfer_failed", errorMessage: transferResult.error?.slice(0, 300) });
      return NextResponse.json({ ok: false, error: transferResult.error }, { status: 502 });
    }

    await updateWithdrawal(withdrawalId, {
      status: "attestation_received",
      gatewayTransferId: transferResult.transferId || undefined,
      attestationHash: transferResult.attestationHash || undefined,
    });

    // 7. Create UCW mint challenge
    const mintIdempotencyKey = randomUUID();
    try {
      const { challengeId: mintChallengeId } = await createGatewayMintChallenge(
        session.userToken,
        session.walletId,
        transferResult.attestation!,
        transferResult.operatorSignature!,
        mintIdempotencyKey,
      );

      await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending",
        mintChallengeId,
        mintIdempotencyKey,
      });

      return NextResponse.json({
        ok: true,
        withdrawalId,
        status: "mint_approval_pending",
        mintChallengeId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "mint_challenge_failed", errorMessage: msg.slice(0, 300) });
      return NextResponse.json({ ok: false, error: "Mint challenge creation failed" }, { status: 502 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/withdraw/sign] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Signature submission failed" }, { status: 500 });
  }
}
