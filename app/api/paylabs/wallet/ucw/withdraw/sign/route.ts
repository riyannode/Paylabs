/**
 * POST /api/paylabs/wallet/ucw/withdraw/sign — Submit user signature
 *
 * Request: { withdrawalId, signature }
 * Response: { withdrawalId, status, mintChallengeId }
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/ucw";
import { submitGatewayTransfer } from "@/lib/paylabs/withdrawal/gateway-transfer";
import { createGatewayMintChallenge } from "@/lib/paylabs/ucw";
import { getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";

async function getUcwSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return null;
  return getSession(sid);
}

export async function POST(req: NextRequest) {
  try {
    const session = await getUcwSession(req);
    if (!session?.userToken || !session.walletId) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const withdrawalId = body.withdrawalId;
    const signature = body.signature;

    if (!withdrawalId || typeof withdrawalId !== "string") {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string") {
      return NextResponse.json({ ok: false, error: "signature required" }, { status: 400 });
    }

    // Reject unexpected fields
    const allowed = new Set(["withdrawalId", "signature"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        return NextResponse.json({ ok: false, error: `Unexpected field: ${key}` }, { status: 400 });
      }
    }

    // Load withdrawal
    const { row, error: loadError } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    if (loadError || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }

    // CAS: burn_signature_pending → burn_signed
    const cas1 = await updateWithdrawal(withdrawalId, { status: "burn_signed", expectedStatus: "burn_signature_pending" });
    if (!cas1.ok || !cas1.row) {
      return NextResponse.json({ ok: false, error: `CAS failed: expected burn_signature_pending, current: ${row.status}` }, { status: 409 });
    }

    // Load canonical BurnIntent from DB
    const burnIntent = row.burn_intent;
    if (!burnIntent || !burnIntent.spec) {
      const casFail = await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "missing_burn_intent", errorMessage: "BurnIntent not in DB" });
      if (!casFail.ok) console.error("[ucw/sign] CAS failed:", casFail.error);
      return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
    }

    // Verify destination
    const expectedRecipient = "0x" + session.walletAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (burnIntent.spec.destinationRecipient !== expectedRecipient) {
      const casBad = await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "destination_mismatch" });
      if (!casBad.ok) console.error("[ucw/sign] CAS failed:", casBad.error);
      return NextResponse.json({ ok: false, error: "Destination mismatch" }, { status: 403 });
    }

    // Submit to Gateway
    const transferResult = await submitGatewayTransfer({ burnIntent, signature });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        const casAmb = await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        if (!casAmb.ok) console.error("[ucw/sign] CAS failed:", casAmb.error);
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }

      // Missing transferId with attestation = protocol error → reconciliation
      if (transferResult.attestation && !transferResult.transferId) {
        const casProto = await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "missing_transfer_id", errorMessage: "Gateway returned attestation but no transferId" });
        if (!casProto.ok) console.error("[ucw/sign] CAS failed:", casProto.error);
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }

      const casFail = await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "gateway_transfer_failed", errorMessage: transferResult.error?.slice(0, 300) });
      if (!casFail.ok) console.error("[ucw/sign] CAS failed:", casFail.error);
      return NextResponse.json({ ok: false, error: transferResult.error }, { status: 502 });
    }

    // CAS: burn_signed → gateway_submitted (CHECK CAS)
    const cas2 = await updateWithdrawal(withdrawalId, {
      status: "gateway_submitted",
      expectedStatus: "burn_signed",
      gatewayTransferId: transferResult.transferId,
    });
    if (!cas2.ok || !cas2.row) {
      console.error("[ucw/sign] CAS failed persisting transferId:", cas2.error);
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }

    // CAS: gateway_submitted → attestation_received (CHECK CAS)
    const cas3 = await updateWithdrawal(withdrawalId, {
      status: "attestation_received",
      expectedStatus: "gateway_submitted",
      attestationHash: transferResult.attestationHash,
    });
    if (!cas3.ok || !cas3.row) {
      console.error("[ucw/sign] CAS failed persisting attestation:", cas3.error);
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }

    // Gas preflight
    const mintIdempotencyKey = randomUUID();
    let gasPreflightOk = false;
    let gasPreflightFee: string | undefined;
    try {
      const { estimateMintFee } = await import("@/lib/paylabs/ucw");
      const feeEstimate = await estimateMintFee(session.userToken, session.walletId, transferResult.attestation, transferResult.operatorSignature);
      gasPreflightFee = (feeEstimate.medium as any)?.networkFee;
      gasPreflightOk = !!gasPreflightFee;
    } catch { /* proceed */ }

    // Create UCW mint challenge — on failure → reconciliation_required
    try {
      const { challengeId: mintChallengeId } = await createGatewayMintChallenge(
        session.userToken, session.walletId, transferResult.attestation, transferResult.operatorSignature, mintIdempotencyKey,
      );

      // CAS: attestation_received → mint_approval_pending (CHECK CAS)
      const cas4 = await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending",
        expectedStatus: "attestation_received",
        mintChallengeId,
        mintIdempotencyKey,
        gasPreflightOk,
        gasPreflightFee,
      });
      if (!cas4.ok || !cas4.row) {
        console.error("[ucw/sign] CAS failed persisting mint challenge:", cas4.error);
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }

      return NextResponse.json({ ok: true, withdrawalId, status: "mint_approval_pending", mintChallengeId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const casMintFail = await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required",
        expectedStatus: "attestation_received",
        mintIdempotencyKey,
        errorCode: "mint_challenge_failed",
        errorMessage: msg.slice(0, 300),
        gasPreflightOk,
        gasPreflightFee,
      });
      if (!casMintFail.ok) console.error("[ucw/sign] CAS failed:", casMintFail.error);
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/sign] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Signature submission failed" }, { status: 500 });
  }
}
