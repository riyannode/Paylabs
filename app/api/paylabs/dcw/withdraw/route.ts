/**
 * POST /api/paylabs/dcw/withdraw — Initiate DCW Gateway withdrawal (async)
 * GET  /api/paylabs/dcw/withdraw?withdrawalId=uuid — Check withdrawal status
 *
 * DCW withdrawal flow:
 *   POST: estimate → sign → submit → mint → return immediately
 *   GET:  poll status (frontend or reconciliation handles long-polling)
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
import { submitGatewayTransfer, computeBurnIntentDigest } from "@/lib/paylabs/withdrawal/gateway-transfer";
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

// ─── GET: Status ─────────────────────────────────────────────

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

    return NextResponse.json({ ok: true, ...safeResponse(row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── POST: Initiate Withdrawal (async — returns after mint submission) ──

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

    // 6. Build TransferSpec
    const spec = buildTransferSpec({ walletAddress, amountAtomic });

    // 7. Gateway estimate
    const estimate = await estimateGatewayWithdrawal({ spec });
    if (!estimate.ok || !estimate.burnIntent) {
      return NextResponse.json({ ok: false, error: estimate.error || "Gateway estimate failed" }, { status: 502 });
    }

    // 8. Fee cap validation
    if (estimate.gatewayFee) {
      const feeValidation = validateFeeCap({ estimatedFee: estimate.gatewayFee });
      if (!feeValidation.ok) {
        return NextResponse.json({ ok: false, error: feeValidation.error }, { status: 400 });
      }
    }

    // 9. Compute burn intent hash (real keccak-256 of canonical JSON)
    const burnIntentHash = await computeBurnIntentDigest(estimate.burnIntent);

    // 10. Store canonical BurnIntent — check for idempotent duplicate
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

    // IDEMPOTENT DUPLICATE — return existing withdrawal, DO NOT process further
    if (!created) {
      return NextResponse.json({ ok: true, ...safeResponse(row) });
    }

    const withdrawalId = row.id;

    // 11. CAS: prepared → burn_signed
    const casResult = await updateWithdrawal(withdrawalId, {
      status: "burn_signed",
      expectedStatus: "prepared",
    });
    if (!casResult.ok || !casResult.row) {
      return NextResponse.json({ ok: false, error: "Concurrent modification detected" }, { status: 409 });
    }

    // 12. Sign BurnIntent using dedicated Gateway signer
    let burnSignature: string;
    try {
      burnSignature = await signGatewayBurnIntent(walletId, estimate.burnIntent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, { status: "failed", expectedStatus: "burn_signed", errorCode: "signing_failed", errorMessage: msg.slice(0, 300) });
      return NextResponse.json({ ok: false, error: "BurnIntent signing failed" }, { status: 502 });
    }

    // 13. Submit signed BurnIntent to Gateway
    const transferResult = await submitGatewayTransfer({
      burnIntent: estimate.burnIntent,
      signature: burnSignature,
    });

    if (!transferResult.ok) {
      if (transferResult.ambiguous) {
        await updateWithdrawal(withdrawalId, { status: "reconciliation_required", expectedStatus: "burn_signed", errorCode: "gateway_timeout", errorMessage: transferResult.error });
        return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc) }) });
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

    // 14. Gas preflight — estimate fee with actual attestation before mint
    let mintIdempotencyKey = crypto.randomUUID();
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
    } catch {
      // Fee estimation failed — proceed anyway (Circle may sponsor gas)
    }

    // 15. Attempt mint — on failure, set reconciliation_required (NOT failed)
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
        // Mint submission returned no ID — reconciliation needed
        await updateWithdrawal(withdrawalId, {
          status: "reconciliation_required",
          expectedStatus: "attestation_received",
          mintIdempotencyKey,
          errorCode: "mint_no_tx_id",
          errorMessage: "Circle returned no transaction ID for mint",
        });
        return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc), gateway_transfer_id: transferResult.transferId }) });
      }

      // CAS: attestation_received → mint_submitted
      await updateWithdrawal(withdrawalId, {
        status: "mint_submitted",
        expectedStatus: "attestation_received",
        mintIdempotencyKey,
        circleTransactionId: mintTxId,
        gasPreflightOk,
        gasPreflightFee,
      });

      // Return immediately — do NOT poll here
      const { row: finalRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
      return NextResponse.json({ ok: true, ...safeResponse(finalRow || row) });

    } catch (e: unknown) {
      // Gateway attestation exists but mint creation failed → reconciliation, NOT failed
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, {
        status: "reconciliation_required",
        expectedStatus: "attestation_received",
        mintIdempotencyKey,
        errorCode: "mint_submission_failed",
        errorMessage: msg.slice(0, 300),
      });
      return NextResponse.json({ ok: true, ...safeResponse({ id: withdrawalId, status: "reconciliation_required", wallet_address: walletAddress, amount_usdc: parseFloat(amountUsdc), gateway_transfer_id: transferResult.transferId }) });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/withdraw] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Withdrawal failed" }, { status: 500 });
  }
}
