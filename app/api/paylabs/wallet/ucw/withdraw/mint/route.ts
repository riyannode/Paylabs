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
import { getSession, getUserChallenge, getTransactionStatus, refreshSession } from "@/lib/paylabs/ucw";
import { getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import type { WithdrawalRow, WithdrawalStatus } from "@/lib/paylabs/withdrawal/gateway-types";
import { explorerUrl } from "@/lib/paylabs/withdrawal/explorer";

const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED", "STUCK"]);
const RECOVERABLE_MINT_STATUSES = new Set<WithdrawalStatus>([
  "gateway_submitted",
  "attestation_received",
  "mint_submission_pending",
  "reconciliation_required",
]);

const UCW_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 1800,
};

async function getUcwSession(req: NextRequest) {
  const sid = req.cookies.get("ucw_sid")?.value;
  if (!sid) return null;
  return getSession(sid);
}

function safeResponse(row: any) {
  return {
    withdrawalId: row.id,
    status: row.status,
    mintChallengeId: row.mint_challenge_id || null,
    circleTransactionId: row.circle_transaction_id || null,
    txHash: row.tx_hash || null,
    explorerUrl: row.explorer_url || null,
  };
}

async function refreshedStatusResponse(
  req: NextRequest,
  body: Record<string, unknown>,
) {
  const sid = req.cookies.get("ucw_sid")?.value;

  if (sid) {
    await refreshSession(sid);
  }

  const response = NextResponse.json(body);
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");

  if (sid) {
    response.cookies.set("ucw_sid", sid, UCW_COOKIE_OPTIONS);
  }

  return response;
}

async function refreshedRowResponse(
  req: NextRequest,
  withdrawalId: string,
  walletId: string,
  fallback: WithdrawalRow,
) {
  const { row } = await getWithdrawal(withdrawalId, "creator_ucw", walletId);
  return refreshedStatusResponse(req, { ok: true, ...safeResponse(row || fallback) });
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
            return refreshedStatusResponse(req, { ok: true, ...safeResponse(casResult.row) });
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
                  return refreshedStatusResponse(req, { ok: true, ...safeResponse(casFinal.row) });
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
                  return refreshedStatusResponse(req, { ok: true, ...safeResponse(casRetry.row) });
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
    return refreshedStatusResponse(req, safeResponse(freshRow || row));
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
    // ─── recover-challenge action ──────────────────────────────
    // Authenticated recovery for Gateway-submitted, attested, mint-submission,
    // and explicit reconciliation states. This never exposes attestation data.
    if (action === "recover-challenge") {
      if (!RECOVERABLE_MINT_STATUSES.has(row.status)) {
        return NextResponse.json({ ok: false, error: `Cannot recover from status '${row.status}'` }, { status: 400 });
      }
      if (!row.gateway_transfer_id) {
        return NextResponse.json({ ok: false, error: "Missing persisted transferId" }, { status: 400 });
      }

      const { getGatewayTransferById, keccak256Hex } = await import("@/lib/paylabs/withdrawal/gateway-transfer");
      const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
      if (!gwTransfer.ok || !gwTransfer.data) {
        await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required", expectedStatus: row.status,
          errorCode: "gateway_get_failed", errorMessage: "Gateway GET failed during recovery",
        });
        return refreshedRowResponse(req, withdrawalId, session.walletId, row);
      }

      const gwStatus = (gwTransfer.data.status || "").toLowerCase();

      if (gwStatus === "failed" || gwStatus === "expired") {
        await updateWithdrawal(withdrawalId, {
          status: "failed", expectedStatus: row.status,
          errorCode: `gateway_${gwStatus}`, errorMessage: `Gateway transfer ${gwStatus}`,
        });
        return refreshedRowResponse(req, withdrawalId, session.walletId, row);
      }

      if (gwStatus === "confirmed" || gwStatus === "finalized") {
        await updateWithdrawal(withdrawalId, {
          status: "finalized", expectedStatus: row.status,
          txHash: gwTransfer.data.transactionHash || undefined,
          explorerUrl: explorerUrl(gwTransfer.data.transactionHash) || undefined,
        });
        return refreshedRowResponse(req, withdrawalId, session.walletId, row);
      }

      const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;
      if (gwStatus !== "pending" || !hasAttestation) {
        await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required", expectedStatus: row.status,
          errorCode: gwStatus === "pending" ? "missing_attestation" : "gateway_unknown_status",
          errorMessage: gwStatus === "pending"
            ? "Gateway pending without attestation during recovery"
            : `Gateway status: ${gwStatus || "empty"}`,
        });
        return refreshedRowResponse(req, withdrawalId, session.walletId, row);
      }

      let currentRow: WithdrawalRow = row;
      const attestationHash = currentRow.attestation_hash || keccak256Hex(gwTransfer.data.attestationPayload!);

      if (currentRow.status === "gateway_submitted") {
        const casAttested = await updateWithdrawal(withdrawalId, {
          status: "attestation_received",
          expectedStatus: "gateway_submitted",
          attestationHash,
        });
        if (!casAttested.ok || !casAttested.row) {
          return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
        }
        currentRow = casAttested.row;
      }

      if (currentRow.status === "attestation_received") {
        const mintKey = currentRow.mint_idempotency_key || crypto.randomUUID();
        const casPending = await updateWithdrawal(withdrawalId, {
          status: "mint_submission_pending",
          expectedStatus: "attestation_received",
          attestationHash,
          mintIdempotencyKey: mintKey,
        });
        if (!casPending.ok || !casPending.row) {
          return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
        }
        currentRow = casPending.row;
      }

      if (currentRow.status === "reconciliation_required") {
        if (currentRow.circle_transaction_id) {
          const previousTransactionId = currentRow.circle_transaction_id;
          try {
            const txStatus = await getTransactionStatus(session.userToken, previousTransactionId);
            if (SUCCESS.has(txStatus.state)) {
              const finalized = await updateWithdrawal(withdrawalId, {
                status: "finalized",
                expectedStatus: "reconciliation_required",
                txHash: txStatus.txHash || undefined,
                explorerUrl: explorerUrl(txStatus.txHash) || undefined,
              });
              if (!finalized.ok || !finalized.row) {
                return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
              }
              return refreshedStatusResponse(req, { ok: true, ...safeResponse(finalized.row) });
            }
            if (!FAILURE.has(txStatus.state)) {
              return refreshedStatusResponse(req, { ok: true, ...safeResponse(currentRow) });
            }
          } catch {
            return refreshedStatusResponse(req, { ok: true, ...safeResponse(currentRow) });
          }

          const retryKey = crypto.randomUUID();
          const existingMetadata = (currentRow.safe_metadata as Record<string, unknown>) || {};
          const previousRetryAttempt =
            typeof existingMetadata.retryAttempt === "number" ? existingMetadata.retryAttempt : 0;
          const casRetry = await updateWithdrawal(withdrawalId, {
            status: "mint_submission_pending",
            expectedStatus: "reconciliation_required",
            attestationHash,
            mintIdempotencyKey: retryKey,
            mintChallengeId: null,
            circleTransactionId: null,
            txHash: null,
            explorerUrl: null,
            safeMetadata: {
              ...existingMetadata,
              retryAttempt: previousRetryAttempt + 1,
              previousTransactionId,
            },
          });
          if (!casRetry.ok || !casRetry.row) {
            return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
          }
          currentRow = casRetry.row;
        } else if (currentRow.mint_idempotency_key && !currentRow.mint_challenge_id) {
          const casResume = await updateWithdrawal(withdrawalId, {
            status: "mint_submission_pending",
            expectedStatus: "reconciliation_required",
            attestationHash,
          });
          if (!casResume.ok || !casResume.row) {
            return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
          }
          currentRow = casResume.row;
        } else {
          return refreshedStatusResponse(req, { ok: true, ...safeResponse(currentRow) });
        }
      }

      if (currentRow.status !== "mint_submission_pending") {
        return refreshedStatusResponse(req, { ok: true, ...safeResponse(currentRow) });
      }

      if (currentRow.mint_challenge_id) {
        return refreshedStatusResponse(req, { ok: true, ...safeResponse(currentRow) });
      }

      let mintKey = currentRow.mint_idempotency_key;
      if (!mintKey) {
        mintKey = crypto.randomUUID();
        const casKey = await updateWithdrawal(withdrawalId, {
          expectedStatus: "mint_submission_pending",
          mintIdempotencyKey: mintKey,
          attestationHash,
        });
        if (!casKey.ok || !casKey.row) {
          return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
        }
        currentRow = casKey.row;
      }

      const { createGatewayMintChallenge } = await import("@/lib/paylabs/ucw");
      let mintChallengeId: string;
      try {
        const challenge = await createGatewayMintChallenge(
          session.userToken,
          session.walletId,
          gwTransfer.data.attestationPayload!,
          gwTransfer.data.attestationSignature!,
          mintKey,
        );
        mintChallengeId = challenge.challengeId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required",
          expectedStatus: "mint_submission_pending",
          errorCode: "mint_challenge_failed",
          errorMessage: msg.slice(0, 300),
        });
        return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
      }

      const casResult = await updateWithdrawal(withdrawalId, {
        status: "mint_approval_pending",
        expectedStatus: "mint_submission_pending",
        mintChallengeId,
        mintIdempotencyKey: mintKey,
        attestationHash,
      });
      if (!casResult.ok || !casResult.row) {
        return refreshedRowResponse(req, withdrawalId, session.walletId, currentRow);
      }

      return refreshedStatusResponse(req, { ok: true, ...safeResponse(casResult.row) });
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
            return refreshedStatusResponse(req, { ok: true, ...safeResponse(fallbackRow || row) });
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
            return refreshedStatusResponse(req, { ok: true, ...safeResponse(finCas.row) });
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
    return refreshedStatusResponse(req, { ok: true, ...safeResponse(finalRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ucw/mint] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Mint resolution failed" }, { status: 500 });
  }
}
