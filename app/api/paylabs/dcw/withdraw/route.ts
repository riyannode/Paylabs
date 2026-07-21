/**
 * POST /api/paylabs/dcw/withdraw — Initiate DCW Gateway withdrawal (async)
 * GET  /api/paylabs/dcw/withdraw?withdrawalId=uuid — Check status + poll once
 *
 * DCW withdrawal flow:
 *   POST: early idempotency → estimate → sign → submit → mint → return
 *   GET:  read DB + poll Circle transaction once if mint_submitted
 *
 * REQUIRES valid DCW session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";
import { buildTransferSpec } from "@/lib/paylabs/withdrawal/burn-intent";
import { estimateGatewayWithdrawal } from "@/lib/paylabs/withdrawal/gateway-estimate";
import { signGatewayBurnIntent } from "@/lib/paylabs/withdrawal/gateway-burn-signer";
import { submitGatewayTransfer, computeBurnIntentDigest, getGatewayTransferById } from "@/lib/paylabs/withdrawal/gateway-transfer";
import { validateAmount, validateFeeCap } from "@/lib/paylabs/withdrawal/validate";
import { createWithdrawal, getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import { explorerUrl } from "@/lib/paylabs/withdrawal/explorer";
import { GATEWAY_MINTER_ADDRESS } from "@/lib/paylabs/withdrawal/gateway-types";

const _require = createRequire(import.meta.url);

// ─── DCW Client ──────────────────────────────────────────────

let _dcwClient: any = null;
function getDcwClient() {
  if (_dcwClient) return _dcwClient;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  const mod = _require("@circle-fin/developer-controlled-wallets");
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return _dcwClient;
}

// ─── Tx Polling ──────────────────────────────────────────────

const TERMINAL = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED", "STUCK"]);
const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);

async function pollDcwTxOnce(txId: string): Promise<{ state: string; txHash: string | null }> {
  try {
    const client = getDcwClient();
    const resp = await client.getTransaction({ id: txId });
    const tx = resp?.data?.transaction;
    return { state: tx?.state || "UNKNOWN", txHash: tx?.txHash || null };
  } catch {
    return { state: "UNKNOWN", txHash: null };
  }
}

// ─── Safe Response ───────────────────────────────────────────

function safeResponse(row: any) {
  return {
    withdrawalId: row.id,
    status: row.status,
    amount: row.amount_usdc?.toString() || "0",
    network: "ARC-TESTNET",
    destination: row.wallet_address,
    transferId: row.gateway_transfer_id || null,
    circleTransactionId: row.circle_transaction_id || null,
    txHash: row.tx_hash || null,
    explorerUrl: row.explorer_url || null,
  };
}

// ─── GET: Status + single poll ───────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const withdrawalId = req.nextUrl.searchParams.get("withdrawalId");
    if (!withdrawalId) {
      return NextResponse.json({ ok: false, error: "withdrawalId required" }, { status: 400 });
    }

    const { row, error } = await getWithdrawal(withdrawalId, "dcw", session.sub);
    if (error || !row) {
      return NextResponse.json({ ok: false, error: "Withdrawal not found" }, { status: 404 });
    }

    // If mint_submitted and we have a circle_transaction_id, poll once
    if (row.status === "mint_submitted" && row.circle_transaction_id) {
      const txResult = await pollDcwTxOnce(row.circle_transaction_id);

      if (SUCCESS.has(txResult.state)) {
        const casResult = await updateWithdrawal(withdrawalId, {
          status: "finalized",
          expectedStatus: "mint_submitted",
          txHash: txResult.txHash ?? undefined,
          explorerUrl: explorerUrl(txResult.txHash) ?? undefined,
        });
        if (casResult.ok && casResult.row) {
          return NextResponse.json({ ok: true, ...safeResponse(casResult.row) });
        }
      } else if (TERMINAL.has(txResult.state)) {
        // P0-3: On Circle mint terminal failure, check Gateway transfer
        if (row.gateway_transfer_id) {
          const gwTransfer = await getGatewayTransferById(row.gateway_transfer_id);
          if (gwTransfer.ok && gwTransfer.data) {
            const gwStatus = (gwTransfer.data.status || "").toLowerCase();
            // P0-3: Gateway confirmed/finalized → finalize from Gateway transactionHash
            if (gwStatus === "confirmed" || gwStatus === "finalized") {
              const casFinal = await updateWithdrawal(withdrawalId, {
                status: "finalized",
                expectedStatus: "mint_submitted",
                txHash: gwTransfer.data.transactionHash ?? txResult.txHash ?? undefined,
                explorerUrl: explorerUrl(gwTransfer.data.transactionHash ?? txResult.txHash) ?? undefined,
              });
              if (casFinal.ok && casFinal.row) {
                return NextResponse.json({ ok: true, ...safeResponse(casFinal.row) });
              }
            }
            // Gateway not expired/confirmed/finalized and has attestation → retryable
            const hasAttestation = !!gwTransfer.data.attestationPayload && !!gwTransfer.data.attestationSignature;
            if (hasAttestation && gwStatus !== "expired" && gwStatus !== "confirmed" && gwStatus !== "finalized") {
              const casRetry = await updateWithdrawal(withdrawalId, {
                status: "reconciliation_required",
                expectedStatus: "mint_submitted",
                errorCode: "mint_tx_retryable",
                errorMessage: `Circle tx: ${txResult.state}, Gateway: ${gwStatus}`,
                txHash: txResult.txHash ?? undefined,
              });
              if (casRetry.ok && casRetry.row) {
                return NextResponse.json({ ok: true, ...safeResponse(casRetry.row) });
              }
            }
          }
        }
        // Definitively non-retryable or no attestation → hard failure
        await updateWithdrawal(withdrawalId, {
          status: "failed",
          expectedStatus: "mint_submitted",
          errorCode: "circle_tx_failed",
          errorMessage: `Circle transaction: ${txResult.state}`,
          txHash: txResult.txHash ?? undefined,
        });
      }
      // If not terminal, re-read and return current state
    }

    // Re-read after potential update
    const { row: freshRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
    return NextResponse.json({ ok: true, ...safeResponse(freshRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Initiate Withdrawal ───────────────────────────────

export async function POST(req: NextRequest) {
  try {
    // 1. Auth
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
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

    // 3. Resolve wallet from session
    const { data: wallet, error: walletError } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address")
      .eq("id", session.sub)
      .not("wallet_id", "eq", "")
      .eq("status", "active")
      .limit(1)
      .single();

    if (walletError || !wallet?.wallet_id) {
      return NextResponse.json({ ok: false, error: "No DCW wallet found" }, { status: 404 });
    }

    const walletId = wallet.wallet_id;
    const walletAddress = wallet.wallet_address.toLowerCase();

    // 4. EARLY IDEMPOTENCY CHECK — before balance/estimate
    {
      const db = supabaseAdmin();
      const { data: existing } = await db
        .from("paylabs_gateway_withdrawals")
        .select("*")
        .eq("wallet_mode", "dcw")
        .eq("wallet_id", walletId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();

      if (existing) {
        return NextResponse.json({ ok: true, ...safeResponse(existing) });
      }
    }

    // 5. Check Gateway available balance
    const gwBalance = await checkGatewayBalance({ depositor: walletAddress });
    if (!gwBalance.ok || !gwBalance.balanceAtomic) {
      return NextResponse.json({ ok: false, error: gwBalance.error || "Gateway balance unavailable" }, { status: 502 });
    }

    // 6. Validate amount
    const amountValidation = validateAmount({ amountUsdc, availableAtomic: gwBalance.balanceAtomic });
    if (!amountValidation.ok) {
      return NextResponse.json({ ok: false, error: amountValidation.error }, { status: 400 });
    }
    const amountAtomic = amountValidation.amountAtomic!;

    // 7. Build TransferSpec
    const spec = buildTransferSpec({ walletAddress, amountAtomic });

    // 8. Gateway estimate
    const estimate = await estimateGatewayWithdrawal({ spec });
    if (!estimate.ok || !estimate.burnIntent) {
      return NextResponse.json({ ok: false, error: estimate.error || "Gateway estimate failed" }, { status: 502 });
    }

    // 9. Fee cap validation
    if (estimate.gatewayFee) {
      const feeValidation = validateFeeCap({ estimatedFee: estimate.gatewayFee });
      if (!feeValidation.ok) {
        return NextResponse.json({ ok: false, error: feeValidation.error }, { status: 400 });
      }
    }

    // 10. Compute burn intent hash (real EIP-712 digest)
    const burnIntentHash = computeBurnIntentDigest(estimate.burnIntent);

    // 11. Store canonical BurnIntent
    const { created, row, error: createError } = await createWithdrawal({
      walletMode: "dcw",
      ownerRef: session.sub,
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

    const withdrawalId = row.id;

    // 12. CAS: prepared → burn_signed
    const cas1 = await updateWithdrawal(withdrawalId, { status: "burn_signed", expectedStatus: "prepared" });
    if (!cas1.ok || !cas1.row) {
      return NextResponse.json({ ok: false, error: "Concurrent modification" }, { status: 409 });
    }

    // 13. Sign BurnIntent
    let burnSignature: string;
    try {
      burnSignature = await signGatewayBurnIntent(walletId, estimate.burnIntent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const casFail = await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "signing_failed", errorMessage: msg.slice(0, 300) });
      if (!casFail.ok) console.error("[dcw/withdraw] CAS failed after signing error:", casFail.error);
      return NextResponse.json({ ok: false, error: "BurnIntent signing failed" }, { status: 502 });
    }

    // 14. Submit to Gateway
    const transferResult = await submitGatewayTransfer({ burnIntent: estimate.burnIntent, signature: burnSignature });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        const casAmb = await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        if (!casAmb.ok) console.error("[dcw/withdraw] CAS failed after ambiguous:", casAmb.error);
        return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
      }

      // transferId missing with attestation = protocol error → reconciliation, NOT failed
      if (transferResult.attestation && !transferResult.transferId) {
        const casProto = await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "missing_transfer_id", errorMessage: "Gateway returned attestation but no transferId" });
        if (!casProto.ok) console.error("[dcw/withdraw] CAS failed after protocol error:", casProto.error);
        return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
      }

      const casFail = await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "gateway_transfer_failed", errorMessage: transferResult.error?.slice(0, 300) });
      if (!casFail.ok) console.error("[dcw/withdraw] CAS failed after gateway error:", casFail.error);
      return NextResponse.json({ ok: false, error: transferResult.error }, { status: 502 });
    }

    // 15. CAS: burn_signed → gateway_submitted (CHECK CAS RESULT)
    const cas2 = await updateWithdrawal(withdrawalId, {
      status: "gateway_submitted",
      expectedStatus: "burn_signed",
      gatewayTransferId: transferResult.transferId,
    });
    if (!cas2.ok || !cas2.row) {
      // P0-1: Use monotonic recovery to persist transferId and advance state
      const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
      const recoveryResult = await monotonicRecoveryPersist(
        withdrawalId, "dcw", session.sub,
        ["burn_signed"],
        { gatewayTransferId: transferResult.transferId, attestationHash: transferResult.attestationHash },
        "attestation_received",
      );
      if (recoveryResult.ok && recoveryResult.row) {
        return NextResponse.json({ ok: true, ...safeResponse(recoveryResult.row) });
      }
      // Recovery failed — re-read and return from DB
      const { row: recheckRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
      return NextResponse.json({ ok: true, ...safeResponse(recheckRow || { id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
    }

    // 16. CAS: gateway_submitted → attestation_received (CHECK CAS RESULT)
    const cas3 = await updateWithdrawal(withdrawalId, {
      status: "attestation_received",
      expectedStatus: "gateway_submitted",
      attestationHash: transferResult.attestationHash,
    });
    if (!cas3.ok || !cas3.row) {
      // P0-1: Use monotonic recovery to persist attestationHash and advance state
      const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
      const recoveryResult = await monotonicRecoveryPersist(
        withdrawalId, "dcw", session.sub,
        ["gateway_submitted"],
        { attestationHash: transferResult.attestationHash },
        "attestation_received",
      );
      if (recoveryResult.ok && recoveryResult.row) {
        return NextResponse.json({ ok: true, ...safeResponse(recoveryResult.row) });
      }
      // Recovery failed — re-read and return from DB
      const { row: recheckRow2 } = await getWithdrawal(withdrawalId, "dcw", session.sub);
      return NextResponse.json({ ok: true, ...safeResponse(recheckRow2 || { id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
    }

    // 17. Pre-persist mint idempotency key BEFORE calling Circle
    const mintIdempotencyKey = crypto.randomUUID();
    const casPre = await updateWithdrawal(withdrawalId, {
      status: "mint_submission_pending",
      expectedStatus: "attestation_received",
      mintIdempotencyKey,
    });
    if (!casPre.ok || !casPre.row) {
      // Re-read and return from DB
      const { row: preRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
      return NextResponse.json({ ok: true, ...safeResponse(preRow || { id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
    }

    // 18. Gas preflight
    let gasPreflightOk = false;
    let gasPreflightFee: string | undefined;
    try {
      const client = getDcwClient();
      const feeEstimate = await client.estimateContractExecutionFee({
        source: { walletId },
        contractAddress: GATEWAY_MINTER_ADDRESS,
        abiFunctionSignature: "gatewayMint(bytes,bytes)",
        abiParameters: [transferResult.attestation, transferResult.operatorSignature],
      });
      gasPreflightFee = feeEstimate?.data?.medium?.networkFee;
      gasPreflightOk = !!gasPreflightFee;
    } catch { /* proceed — Circle may sponsor gas */ }

    // 19. Attempt mint — on failure → reconciliation_required
    try {
      const client = getDcwClient();
      const mintTx = await client.createContractExecutionTransaction({
        walletId,
        contractAddress: GATEWAY_MINTER_ADDRESS,
        abiFunctionSignature: "gatewayMint(bytes,bytes)",
        abiParameters: [transferResult.attestation, transferResult.operatorSignature],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        idempotencyKey: mintIdempotencyKey,
      });
      const mintTxId = mintTx?.data?.id;

      if (!mintTxId) {
        const casNoTx = await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required",
          expectedStatus: "mint_submission_pending",
          errorCode: "mint_no_tx_id",
          errorMessage: "Circle returned no transaction ID for mint",
          gasPreflightOk, gasPreflightFee,
        });
        if (!casNoTx.ok) console.error("[dcw/withdraw] CAS failed:", casNoTx.error);
        return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc), gateway_transfer_id: transferResult.transferId }) });
      }

      // CAS: mint_submission_pending → mint_submitted (CHECK CAS RESULT)
      const cas4 = await updateWithdrawal(withdrawalId, {
        status: "mint_submitted",
        expectedStatus: "mint_submission_pending",
        circleTransactionId: mintTxId,
        gasPreflightOk, gasPreflightFee,
      });
      if (!cas4.ok || !cas4.row) {
        // CAS failed — P0-5: use monotonic recovery to persist tx ID and advance state
        const { row: recheck } = await getWithdrawal(withdrawalId, "dcw", session.sub);
        if (!recheck?.circle_transaction_id) {
          // Try to persist via guarded monotonic recovery
          const { monotonicRecoveryPersist } = await import("@/lib/paylabs/withdrawal/reconciliation");
          const recoveryResult = await monotonicRecoveryPersist(
            withdrawalId, "dcw", session.sub,
            ["mint_submission_pending"],
            { circleTransactionId: mintTxId, mintIdempotencyKey },
            "mint_submitted",
          );
          if (recoveryResult.ok && recoveryResult.row) {
            return NextResponse.json({ ok: true, ...safeResponse(recoveryResult.row) });
          }
        }
        // Recovery failed — re-read and return from DB
        const { row: cas4Row } = await getWithdrawal(withdrawalId, "dcw", session.sub);
        return NextResponse.json({ ok: true, ...safeResponse(cas4Row || { id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
      }

      return NextResponse.json({ ok: true, ...safeResponse(cas4.row) });

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required",
        expectedStatus: "mint_submission_pending",
        errorCode: "mint_submission_failed",
        errorMessage: msg.slice(0, 300),
        gasPreflightOk, gasPreflightFee,
      });
      // Re-read and return from DB
      const { row: catchRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
      return NextResponse.json({ ok: true, ...safeResponse(catchRow || { id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/withdraw] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Withdrawal failed" }, { status: 500 });
  }
}
