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
import { submitGatewayTransfer, computeBurnIntentDigest } from "@/lib/paylabs/withdrawal/gateway-transfer";
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
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "missing_burn_intent", errorMessage: "BurnIntent not in DB" });
      return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
    }

    // VERIFY BurnIntent digest integrity before Gateway submission
    const actualDigest = computeBurnIntentDigest(burnIntent);
    if (actualDigest !== row.burn_intent_hash) {
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "burn_intent_tampered", errorMessage: "Stored BurnIntent digest mismatch" });
      return NextResponse.json({ ok: false, error: "BurnIntent integrity check failed" }, { status: 500 });
    }

    // Verify destination
    const expectedRecipient = "0x" + session.walletAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    if (burnIntent.spec.destinationRecipient !== expectedRecipient) {
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "destination_mismatch" });
      return NextResponse.json({ ok: false, error: "Destination mismatch" }, { status: 403 });
    }

    // Submit to Gateway
    const transferResult = await submitGatewayTransfer({ burnIntent, signature });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }
      if (transferResult.attestation && !transferResult.transferId) {
        await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "missing_transfer_id" });
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "gateway_transfer_failed", errorMessage: transferResult.error?.slice(0, 300) });
      return NextResponse.json({ ok: false, error: transferResult.error }, { status: 502 });
    }

    // CAS: burn_signed → gateway_submitted (CHECK CAS)
    const cas2 = await updateWithdrawal(withdrawalId, {
      status: "gateway_submitted", expectedStatus: "burn_signed", gatewayTransferId: transferResult.transferId,
    });
    if (!cas2.ok || !cas2.row) {
      // CAS failed — P0-5/6: use monotonic recovery (never regress state)
      const { row: recheck } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
      if (!recheck?.gateway_transfer_id) {
        const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
        const recoveryResult = await monotonicRecoveryPersist(
          withdrawalId, "creator_ucw", session.walletId,
          ["burn_signed"],
          { gatewayTransferId: transferResult.transferId, attestationHash: transferResult.attestationHash },
          "gateway_submitted",
        );
        if (recoveryResult.ok && recoveryResult.row) {
          return NextResponse.json({ ok: true, withdrawalId, status: "gateway_submitted" });
        }
      }
      // Recovery failed or already advanced — mark for reconciliation
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "cas_recovery",
      });
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }

    // CAS: gateway_submitted → attestation_received (CHECK CAS)
    const cas3 = await updateWithdrawal(withdrawalId, {
      status: "attestation_received", expectedStatus: "gateway_submitted", attestationHash: transferResult.attestationHash,
    });
    if (!cas3.ok || !cas3.row) {
      const { row: recheck } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
      if (!recheck?.attestation_hash) {
        const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
        const recoveryResult = await monotonicRecoveryPersist(
          withdrawalId, "creator_ucw", session.walletId,
          ["gateway_submitted"],
          { attestationHash: transferResult.attestationHash },
          "attestation_received",
        );
        if (recoveryResult.ok && recoveryResult.row) {
          return NextResponse.json({ ok: true, withdrawalId, status: "attestation_received" });
        }
      }
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required", expectedStatus: "gateway_submitted", errorCode: "cas_recovery",
      });
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }

    // P0-4: Pre-persist mint idempotency key BEFORE calling Circle — check CAS result
    const mintIdempotencyKey = randomUUID();
    const casPre = await updateWithdrawal(withdrawalId, {
      status: "mint_submission_pending", expectedStatus: "attestation_received", mintIdempotencyKey,
    });
    if (!casPre.ok || !casPre.row) {
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }

    // Gas preflight
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

      // CAS: mint_submission_pending → mint_approval_pending (CHECK CAS)
      const cas4 = await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending", expectedStatus: "mint_submission_pending",
        mintChallengeId, gasPreflightOk, gasPreflightFee,
      });
      if (!cas4.ok || !cas4.row) {
        // Challenge was created but CAS failed — P0-5/6: monotonic recovery
        const { row: recheck } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
        if (!recheck?.mint_challenge_id) {
          const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
          const recoveryResult = await monotonicRecoveryPersist(
            withdrawalId, "creator_ucw", session.walletId,
            ["mint_submission_pending"],
            { mintChallengeId, mintIdempotencyKey },
            "mint_approval_pending",
          );
          if (recoveryResult.ok && recoveryResult.row) {
            return NextResponse.json({ ok: true, withdrawalId, status: "mint_approval_pending", mintChallengeId });
          }
        }
        await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required", expectedStatus: "mint_submission_pending", errorCode: "cas_recovery",
        });
        return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
      }

      return NextResponse.json({ ok: true, withdrawalId, status: "mint_approval_pending", mintChallengeId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required", expectedStatus: "mint_submission_pending",
        errorCode: "mint_challenge_failed", errorMessage: msg.slice(0, 300), gasPreflightOk, gasPreflightFee,
      });
      return NextResponse.json({ ok: true, withdrawalId, status: "reconciliation_required" });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/sign] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Signature submission failed" }, { status: 500 });
  }
}
