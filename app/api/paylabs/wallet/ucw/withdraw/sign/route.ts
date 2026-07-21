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
import { submitGatewayTransfer } from "@/lib/paylabs/withdrawal/gateway-transfer";
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

    // Reject unexpected fields
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

    // CAS: burn_signature_pending → burn_signed (only one concurrent request wins)
    const casResult = await updateWithdrawal(withdrawalId, {
      status: "burn_signed",
      expectedStatus: "burn_signature_pending",
    });
    if (!casResult.ok || !casResult.row) {
      return NextResponse.json({ ok: false, error: `CAS failed: expected status burn_signature_pending, current: ${row.status}` }, { status: 409 });
    }

    // 4. Load canonical BurnIntent from DB
    const burnIntent = row.burn_intent;
    if (!burnIntent || !burnIntent.spec) {
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "missing_burn_intent", errorMessage: "Canonical BurnIntent not found in DB" });
      return NextResponse.json({ ok: false, error: "Internal error: BurnIntent missing" }, { status: 500 });
    }

    // 5. Verify destination matches authenticated wallet
    const expectedRecipient = "0x" + session.walletAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (burnIntent.spec.destinationRecipient !== expectedRecipient) {
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "destination_mismatch", errorMessage: "Destination does not match wallet" });
      return NextResponse.json({ ok: false, error: "Destination mismatch" }, { status: 403 });
    }

    // 6. Submit to Gateway
    const transferResult = await submitGatewayTransfer({ burnIntent, signature });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "gateway_transfer_failed", errorMessage: transferResult.error?.slice(0, 300) });
      return NextResponse.json({ ok: false, error: transferResult.error }, { status: 502 });
    }

    // CAS: burn_signed → gateway_submitted → attestation_received
    await updateWithdrawal(withdrawalId, {
      status: "gateway_submitted",
      expectedStatus: "burn_signed",
      gatewayTransferId: transferResult.transferId,
    });
    await updateWithdrawal(withdrawalId, {
      status: "attestation_received",
      expectedStatus: "gateway_submitted",
      attestationHash: transferResult.attestationHash,
    });

    // 7. Gas preflight — estimate fee with actual attestation before mint challenge
    const mintIdempotencyKey = randomUUID();
    let gasPreflightOk = false;
    let gasPreflightFee: string | undefined;
    try {
      const { estimateMintFee } = await import("@/lib/paylabs/ucw");
      const feeEstimate = await estimateMintFee(
        session.userToken,
        session.walletId,
        transferResult.attestation,
        transferResult.operatorSignature,
      );
      gasPreflightFee = (feeEstimate.medium as any)?.networkFee;
      gasPreflightOk = !!gasPreflightFee;
    } catch {
      // Fee estimation failed — proceed (Circle may sponsor gas)
    }

    // 8. Create UCW mint challenge — on failure, set reconciliation_required
    try {
      const { challengeId: mintChallengeId } = await createGatewayMintChallenge(
        session.userToken,
        session.walletId,
        transferResult.attestation,
        transferResult.operatorSignature,
        mintIdempotencyKey,
      );

      // CAS: attestation_received → mint_approval_pending
      await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending",
        expectedStatus: "attestation_received",
        mintChallengeId,
        mintIdempotencyKey,
        gasPreflightOk,
        gasPreflightFee,
      });

      return NextResponse.json({
        ok: true,
        withdrawalId,
        status: "mint_approval_pending",
        mintChallengeId,
      });
    } catch (e: unknown) {
      // Gateway attestation exists but mint challenge creation failed
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required",
        expectedStatus: "attestation_received",
        mintIdempotencyKey,
        errorCode: "mint_challenge_failed",
        errorMessage: msg.slice(0, 300),
      });
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/withdraw/sign] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Signature submission failed" }, { status: 500 });
  }
}
