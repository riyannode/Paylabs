/**
 * POST /api/paylabs/wallet/ucw/withdraw/mint — Resolve mint challenge
 * GET  /api/paylabs/wallet/ucw/withdraw/mint?withdrawalId=uuid — Poll mint status
 *
 * After browser executes sdk.execute(mintChallengeId), call POST
 * to resolve the Circle transaction ID via getChallenge → correlationIds → getTransaction.
 *
 * Required flow:
 *   mint_approval_pending → (resolve challenge) → mint_submitted → finalized/failed
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession, getUserChallenge, getTransactionStatus } from "@/lib/paylabs/ucw";
import { getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import type { WithdrawalRow, WithdrawalStatus } from "@/lib/paylabs/withdrawal/gateway-types";
import { explorerUrl } from "@/lib/paylabs/withdrawal/explorer";

const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);

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

    // If mint_submitted and we have a circle_transaction_id, poll once
    if (row.status === "mint_submitted" && row.circle_transaction_id && session.userToken) {
      try {
        const txStatus = await getTransactionStatus(session.userToken, row.circle_transaction_id);

        if (SUCCESS.has(txStatus.state)) {
          const casResult = await updateWithdrawal(withdrawalId, {
            status: "finalized", expectedStatus: "mint_submitted",
            txHash: txStatus.txHash || undefined, explorerUrl: explorerUrl(txStatus.txHash) || undefined,
          });
          if (casResult.ok && casResult.row) {
            return NextResponse.json({ ok: true, ...safeResponse(casResult.row) });
          }
        } else if (FAILURE.has(txStatus.state)) {
          // Circle mint terminal failure — check Gateway transfer
          if (row.gateway_transfer_id) {
            const { getGatewayTransferById } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
            const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
            if (gwTransfer.ok && gwTransfer.data) {
              const gwStatus = (gwTransfer.data.status || "").toLowerCase();
              const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;

              // confirmed/finalized → finalize using Gateway transactionHash
              if (gwStatus === "confirmed" || gwStatus === "finalized") {
                const casFinal = await updateWithdrawal(withdrawalId, {
                  status: "finalized", expectedStatus: "mint_submitted",
                  txHash: gwTransfer.data.transactionHash || txStatus.txHash || undefined,
                  explorerUrl: explorerUrl(gwTransfer.data.transactionHash || txStatus.txHash) || undefined,
                });
                if (casFinal.ok && casFinal.row) {
                  return NextResponse.json({ ok: true, ...safeResponse(casFinal.row) });
                }
              }

              // failed/expired → failed
              if (gwStatus === "failed" || gwStatus === "expired") {
                await updateWithdrawal(withdrawalId, {
                  status: "failed", expectedStatus: "mint_submitted",
                  errorCode: `gateway_${gwStatus}`, errorMessage: `Gateway: ${gwStatus}, Circle: ${txStatus.state}`,
                  txHash: txStatus.txHash || undefined,
                });
              } else if (gwStatus === "pending" && hasAttestation) {
                // pending + attestation → retryable
                const casRetry = await updateWithdrawal(withdrawalId, {
                  status: "reconciliation_required", expectedStatus: "mint_submitted",
                  errorCode: "mint_tx_retryable", errorMessage: `Circle tx: ${txStatus.state}, Gateway: ${gwStatus}`,
                  txHash: txStatus.txHash || undefined,
                });
                if (casRetry.ok && casRetry.row) {
                  return NextResponse.json({ ok: true, ...safeResponse(casRetry.row) });
                }
              } else {
                // Gateway GET failure, empty status, unknown, missing attestation → reconciliation_required
                await updateWithdrawal(withdrawalId, {
                  status: "reconciliation_required", expectedStatus: "mint_submitted",
                  errorCode: "gateway_unavailable", errorMessage: `Gateway: ${gwStatus || 'empty'}, Circle: ${txStatus.state}`,
                  txHash: txStatus.txHash || undefined,
                });
              }
            } else {
              // Gateway GET temporarily unavailable → reconciliation_required, never failed
              await updateWithdrawal(withdrawalId, {
                status: "reconciliation_required", expectedStatus: "mint_submitted",
                errorCode: "gateway_unavailable", errorMessage: `Gateway GET failed, Circle: ${txStatus.state}`,
                txHash: txStatus.txHash || undefined,
              });
            }
          } else {
            // No transfer reference — hard failure
            await updateWithdrawal(withdrawalId, {
              status: "failed", expectedStatus: "mint_submitted",
              errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txStatus.state}`,
              txHash: txStatus.txHash || undefined,
            });
          }
        }
      } catch { /* polling failed — leave status as is */ }
    }

    // Re-read after potential update
    const { row: freshRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    return NextResponse.json({ ok: true, ...safeResponse(freshRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Resolve Mint Challenge ────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const session = await getUcwSession(req);
    if (!session?.userToken || !session.walletId) {
      return NextResponse.json({ ok: false, error: "UCW authentication required" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const withdrawalId = body.withdrawalId;
    const action = body.action;

    if (!withdrawalId || typeof withdrawalId !== "string") {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }

    const { row, error: loadError } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    if (loadError || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }
    // Mutable reference — may advance during terminal failure CAS gate
    let currentRow: WithdrawalRow = row;

    // ─── recover-challenge action ──────────────────────────────
    // Authenticated recovery for mint_submission_pending or reconciliation_required
    // where key was persisted but challenge was never created (crash) or
    // Circle mint transaction explicitly failed (terminal failure).
    if (action === "recover-challenge") {
      // Require status mint_submission_pending or reconciliation_required
      if (row.status !== "mint_submission_pending" && row.status !== "reconciliation_required") {
        return NextResponse.json({ ok: false, error: `Cannot recover from status '${row.status}'` }, { status: 400 });
      }
      // Require persisted mintIdempotencyKey and gatewayTransferId
      if (!row.mint_idempotency_key || !row.gateway_transfer_id) {
        return NextResponse.json({ ok: false, error: "Missing persisted key or transferId" }, { status: 400 });
      }

      // GET /v1/transfer/{transferId}
      const { getGatewayTransferById } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
      const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
      if (!gwTransfer.ok || !gwTransfer.data) {
        return NextResponse.json({ ok: false, error: "Gateway transfer recovery failed" }, { status: 502 });
      }

      const gwStatus = (gwTransfer.data.status || "").toLowerCase();

      // Gateway failed/expired → do not call gatewayMint
      if (gwStatus === "failed" || gwStatus === "expired") {
        await updateWithdrawal(withdrawalId, {
          status: "failed", expectedStatus: row.status,
          errorCode: `gateway_${gwStatus}`, errorMessage: `Gateway transfer ${gwStatus}`,
        });
        // Re-read and return from DB
        const { row: failRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
        return NextResponse.json({ ok: true, ...safeResponse(failRow || row) });
      }

      // Gateway confirmed/finalized → finalize from Gateway transactionHash
      if (gwStatus === "confirmed" || gwStatus === "finalized") {
        const casFinal = await updateWithdrawal(withdrawalId, {
          status: "finalized", expectedStatus: row.status,
          txHash: gwTransfer.data.transactionHash || undefined,
          explorerUrl: explorerUrl(gwTransfer.data.transactionHash) || undefined,
        });
        // Re-read and return from DB
        const { row: finRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
        return NextResponse.json({ ok: true, ...safeResponse(finRow || row) });
      }

      // Retrieve attestation payload/signature
      if (!gwTransfer.data.attestationPayload || !gwTransfer.data.attestationSignature) {
        return NextResponse.json({ ok: false, error: "Gateway attestation not available" }, { status: 502 });
      }

      // ─── Distinguish crash recovery vs terminal failure ────────
      // A. Row is mint_submission_pending → crash recovery → reuse CURRENTLY persisted key
      //    (do NOT generate new key even if old circle_transaction_id points to failed tx)
      // B. Row is reconciliation_required AND Circle tx terminal FAILED → new key + CAS gate
      let useKey = row.mint_idempotency_key;
      let expectedStatusForChallenge: WithdrawalStatus = row.status;

      if (row.status === "reconciliation_required" && row.circle_transaction_id) {
        // Check if Circle transaction explicitly failed — only then generate new key
        try {
          const txStatus = await getTransactionStatus(session.userToken, row.circle_transaction_id);
          const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);
          if (FAILURE.has(txStatus.state)) {
            // Terminal failure → CAS to exclusive retry state, generate NEW key
            useKey = crypto.randomUUID();
            const casGate = await updateWithdrawal(withdrawalId, {
              status: "mint_submission_pending",
              expectedStatus: row.status,
              mintIdempotencyKey: useKey,
              safeMetadata: {
                ...((row.safe_metadata as Record<string, unknown>) || {}),
                retryAttempt: ((row.safe_metadata as any)?.retryAttempt || 0) + 1,
                previousTransactionId: row.circle_transaction_id,
              },
            });
            if (!casGate.ok || !casGate.row) {
              // Another worker won the CAS or status changed
              const { row: recheck } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
              return NextResponse.json({ ok: true, ...safeResponse(recheck || row) });
            }
            currentRow = casGate.row;
            expectedStatusForChallenge = "mint_submission_pending";
          }
          // If not FAILURE (still in progress, or SUCCESS handled above), use same key
        } catch {
          // Cannot determine Circle tx status — safest to reuse same key (idempotent)
        }
      }

      // Call createGatewayMintChallenge
      const { createGatewayMintChallenge } = await import("@/lib/paylabs/ucw");
      let mintChallengeId: string;
      try {
        const challenge = await createGatewayMintChallenge(
          session.userToken, session.walletId,
          gwTransfer.data.attestationPayload, gwTransfer.data.attestationSignature,
          useKey,
        );
        mintChallengeId = challenge.challengeId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ ok: false, error: `Challenge creation failed: ${msg.slice(0, 200)}` }, { status: 502 });
      }

      // CAS persist mintChallengeId → mint_approval_pending
      const casResult = await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending", expectedStatus: expectedStatusForChallenge,
        mintChallengeId, mintIdempotencyKey: useKey,
      });
      if (!casResult.ok || !casResult.row) {
        // CAS failed — try monotonic recovery
        const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
        const recoveryResult = await monotonicRecoveryPersist(
          withdrawalId, "creator_ucw", session.walletId,
          [expectedStatusForChallenge],
          { mintChallengeId, mintIdempotencyKey: useKey },
          "mint_approval_pending",
          ["mint_approval_pending"],
        );
        if (!recoveryResult.ok || !recoveryResult.row) {
          // Re-read and return actual DB state (Blocker 5)
          const { row: failRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
          return NextResponse.json({ ok: true, ...safeResponse(failRow || row) });
        }
        // Re-read to return from DB
        const { row: recoveredRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
        return NextResponse.json({ ok: true, ...safeResponse(recoveredRow || recoveryResult.row) });
      }

      // Re-read to return from DB (Blocker 5)
      const { row: finalRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
      const responseRow = finalRow || casResult.row;
      return NextResponse.json({
        ok: true,
        withdrawalId: responseRow.id,
        status: responseRow.status,
        mintChallengeId: responseRow.mint_challenge_id,
      });
    }

    // ─── Existing: resolve-challenge flow ────────────────────
    if (!row.mint_challenge_id) {
      return NextResponse.json({ ok: false, error: "No mint challenge to resolve" }, { status: 400 });
    }

    // Resolve challenge → correlationIds → transaction ID
    let resolvedTxId: string | null = null;
    try {
      const challenge = await getUserChallenge(session.userToken, row.mint_challenge_id);
      const correlationId = challenge.correlationIds?.[0];
      if (correlationId) {
        resolvedTxId = correlationId;
      }
    } catch { /* challenge resolution failed */ }

    if (resolvedTxId) {
      // CAS: mint_approval_pending → mint_submitted (CHECK CAS)
      const casResult = await updateWithdrawal(withdrawalId, {
        status: "mint_submitted", expectedStatus: "mint_approval_pending",
        circleTransactionId: resolvedTxId,
      });

      if (!casResult.ok || !casResult.row) {
        // CAS failed — P0-5/6: monotonic recovery (never regress state)
        const { row: recheck } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
        if (recheck?.circle_transaction_id) {
          // Already stored — proceed to poll
        } else {
          const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
          const recoveryResult = await monotonicRecoveryPersist(
            withdrawalId, "creator_ucw", session.walletId,
            ["mint_approval_pending"],
            { circleTransactionId: resolvedTxId },
            "mint_submitted",
            ["mint_submitted"],
          );
          if (!recoveryResult.ok || !recoveryResult.row) {
            // Re-read and return actual DB state
            const { row: fallbackRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
            return NextResponse.json({ ok: true, ...safeResponse(fallbackRow || row) });
          }
        }
      }

      // Try to poll the transaction immediately
      try {
        const txStatus = await getTransactionStatus(session.userToken, resolvedTxId);
        if (SUCCESS.has(txStatus.state)) {
          const finCas = await updateWithdrawal(withdrawalId, {
            status: "finalized", expectedStatus: "mint_submitted",
            txHash: txStatus.txHash || undefined, explorerUrl: explorerUrl(txStatus.txHash) || undefined,
          });
          if (finCas.ok && finCas.row) {
            return NextResponse.json({ ok: true, ...safeResponse(finCas.row) });
          }
        } else if (FAILURE.has(txStatus.state)) {
          // Circle mint terminal failure — check Gateway transfer
          if (row.gateway_transfer_id) {
            const { getGatewayTransferById } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
            const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
            if (gwTransfer.ok && gwTransfer.data) {
              const gwStatus = (gwTransfer.data.status || "").toLowerCase();
              const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;

              // confirmed/finalized → finalize using Gateway transactionHash
              if (gwStatus === "confirmed" || gwStatus === "finalized") {
                await updateWithdrawal(withdrawalId, {
                  status: "finalized", expectedStatus: "mint_submitted",
                  txHash: gwTransfer.data.transactionHash || txStatus.txHash || undefined,
                  explorerUrl: explorerUrl(gwTransfer.data.transactionHash || txStatus.txHash) || undefined,
                });
              } else if (gwStatus === "failed" || gwStatus === "expired") {
                // failed/expired → failed
                await updateWithdrawal(withdrawalId, {
                  status: "failed", expectedStatus: "mint_submitted",
                  errorCode: `gateway_${gwStatus}`, errorMessage: `Gateway: ${gwStatus}, Circle: ${txStatus.state}`,
                });
              } else if (gwStatus === "pending" && hasAttestation) {
                // pending + attestation → retryable
                await updateWithdrawal(withdrawalId, {
                  status: "reconciliation_required", expectedStatus: "mint_submitted",
                  errorCode: "mint_tx_retryable", errorMessage: `Circle tx: ${txStatus.state}, Gateway: ${gwStatus}`,
                });
              } else {
                // Gateway GET failure, empty/unknown status, missing attestation → reconciliation_required
                await updateWithdrawal(withdrawalId, {
                  status: "reconciliation_required", expectedStatus: "mint_submitted",
                  errorCode: "gateway_unavailable", errorMessage: `Gateway: ${gwStatus || 'empty'}, Circle: ${txStatus.state}`,
                });
              }
            } else {
              // Gateway GET temporarily unavailable → reconciliation_required, never failed
              await updateWithdrawal(withdrawalId, {
                status: "reconciliation_required", expectedStatus: "mint_submitted",
                errorCode: "gateway_unavailable", errorMessage: `Gateway GET failed, Circle: ${txStatus.state}`,
              });
            }
          } else {
            // No transfer reference — hard failure
            await updateWithdrawal(withdrawalId, {
              status: "failed", expectedStatus: "mint_submitted",
              errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txStatus.state}`,
            });
          }
        }
      } catch { /* poll failed — leave as mint_submitted */ }
    }

    const { row: finalRow } = await getWithdrawal(withdrawalId, "creator_ucw", session.walletId);
    return NextResponse.json({ ok: true, ...safeResponse(finalRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/mint] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Mint resolution failed" }, { status: 500 });
  }
}
