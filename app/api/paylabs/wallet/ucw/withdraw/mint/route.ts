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
          // Mint failed — check Gateway transfer status
          if (row.gateway_transfer_id) {
            const { getGatewayTransferById } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
            const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
            if (gwTransfer.ok && gwTransfer.data) {
              const gwStatus = (gwTransfer.data.status || "").toLowerCase();
              // P0-3: Gateway confirmed/finalized → finalize from Gateway transactionHash
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
              // Gateway not expired/confirmed/finalized and has attestation → retryable
              const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;
              if (hasAttestation && gwStatus !== "expired" && gwStatus !== "confirmed" && gwStatus !== "finalized") {
                const casRetry = await updateWithdrawal(withdrawalId, {
                  status: "reconciliation_required", expectedStatus: "mint_submitted",
                  errorCode: "mint_tx_retryable", errorMessage: `Circle tx: ${txStatus.state}, Gateway: ${gwStatus}`,
                  txHash: txStatus.txHash || undefined,
                });
                if (casRetry.ok && casRetry.row) {
                  return NextResponse.json({ ok: true, ...safeResponse(casRetry.row) });
                }
              }
            }
            // Non-retryable or no attestation — hard failure
            await updateWithdrawal(withdrawalId, {
              status: "failed", expectedStatus: "mint_submitted",
              errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txStatus.state}`,
              txHash: txStatus.txHash || undefined,
            });
          } else {
            // No transfer to retry from — hard failure
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

    // ─── P0-2: recover-challenge action ──────────────────────
    // Authenticated recovery for mint_submission_pending or reconciliation_required
    // where key was persisted but challenge was never created.
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

      // Reject expired/failed transfer
      if (gwStatus === "expired" || gwStatus === "failed") {
        await updateWithdrawal(withdrawalId, {
          status: "failed", expectedStatus: row.status,
          errorCode: `gateway_${gwStatus}`, errorMessage: `Gateway transfer ${gwStatus}`,
        });
        return NextResponse.json({ ok: false, error: `Gateway transfer ${gwStatus}` }, { status: 400 });
      }

      // P0-3: Gateway confirmed/finalized → finalize from Gateway transactionHash
      if (gwStatus === "confirmed" || gwStatus === "finalized") {
        const casFinal = await updateWithdrawal(withdrawalId, {
          status: "finalized", expectedStatus: row.status,
          txHash: gwTransfer.data.transactionHash || undefined,
          explorerUrl: explorerUrl(gwTransfer.data.transactionHash) || undefined,
        });
        if (casFinal.ok && casFinal.row) {
          return NextResponse.json({ ok: true, ...safeResponse(casFinal.row) });
        }
        return NextResponse.json({ ok: true, ...safeResponse(row) });
      }

      // Retrieve attestation payload/signature
      if (!gwTransfer.data.attestationPayload || !gwTransfer.data.attestationSignature) {
        return NextResponse.json({ ok: false, error: "Gateway attestation not available" }, { status: 502 });
      }

      // Call createGatewayMintChallenge using the SAME persisted key
      const { createGatewayMintChallenge } = await import("@/lib/paylabs/ucw");
      let mintChallengeId: string;
      try {
        const challenge = await createGatewayMintChallenge(
          session.userToken, session.walletId,
          gwTransfer.data.attestationPayload, gwTransfer.data.attestationSignature,
          row.mint_idempotency_key,
        );
        mintChallengeId = challenge.challengeId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ ok: false, error: `Challenge creation failed: ${msg.slice(0, 200)}` }, { status: 502 });
      }

      // CAS persist mintChallengeId → mint_approval_pending
      const casResult = await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending", expectedStatus: row.status,
        mintChallengeId, mintIdempotencyKey: row.mint_idempotency_key,
      });
      if (!casResult.ok || !casResult.row) {
        // CAS failed — try monotonic recovery
        const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
        const recoveryResult = await monotonicRecoveryPersist(
          withdrawalId, "creator_ucw", session.walletId,
          [row.status],
          { mintChallengeId, mintIdempotencyKey: row.mint_idempotency_key },
          "mint_approval_pending",
        );
        if (recoveryResult.ok && recoveryResult.row) {
          return NextResponse.json({ ok: true, ...safeResponse(recoveryResult.row) });
        }
        return NextResponse.json({ ok: false, error: "CAS failed during recovery" }, { status: 409 });
      }

      return NextResponse.json({ ok: true, ...safeResponse(casResult.row) });
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
          );
          if (recoveryResult.ok && recoveryResult.row) {
            // Proceed to poll with recovered state
          } else {
            await updateWithdrawal(withdrawalId, {
              status: "reconciliation_required", expectedStatus: "mint_approval_pending", errorCode: "cas_recovery",
            });
            return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required" }) });
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
          // P0-3: Check Gateway transfer status before marking retryable
          if (row.gateway_transfer_id) {
            const { getGatewayTransferById } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
            const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
            if (gwTransfer.ok && gwTransfer.data) {
              const gwStatus = (gwTransfer.data.status || "").toLowerCase();
              // P0-3: Gateway confirmed/finalized → finalize from Gateway transactionHash
              if (gwStatus === "confirmed" || gwStatus === "finalized") {
                await updateWithdrawal(withdrawalId, {
                  status: "finalized", expectedStatus: "mint_submitted",
                  txHash: gwTransfer.data.transactionHash || txStatus.txHash || undefined,
                  explorerUrl: explorerUrl(gwTransfer.data.transactionHash || txStatus.txHash) || undefined,
                });
              } else {
                const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;
                if (hasAttestation && gwStatus !== "expired") {
                  await updateWithdrawal(withdrawalId, {
                    status: "reconciliation_required", expectedStatus: "mint_submitted",
                    errorCode: "mint_tx_retryable", errorMessage: `Circle tx: ${txStatus.state}, Gateway: ${gwStatus}`,
                  });
                } else {
                  await updateWithdrawal(withdrawalId, {
                    status: "failed", expectedStatus: "mint_submitted",
                    errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txStatus.state}`,
                  });
                }
              }
            } else {
              await updateWithdrawal(withdrawalId, {
                status: "failed", expectedStatus: "mint_submitted",
                errorCode: "mint_tx_failed", errorMessage: `Circle tx: ${txStatus.state}`,
              });
            }
          } else {
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
