/**
 * POST /api/paylabs/dcw/withdraw — Initiate DCW Gateway withdrawal
 * GET  /api/paylabs/dcw/withdraw?withdrawalId=uuid — Check withdrawal status
 *
 * DCW withdrawal is fully server-side:
 *   estimate → sign → submit → mint → poll → finalize
 *
 * REQUIRES valid DCW session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { checkGatewayBalance } from "@/lib/paylabs/x402/gateway-balance";
import { usdcDecimalToAtomic } from "@/lib/paylabs/x402/usdc";
import { buildTransferSpec } from "@/lib/paylabs/withdrawal/burn-intent";
import { estimateGatewayWithdrawal } from "@/lib/paylabs/withdrawal/gateway-estimate";
import { signGatewayBurnIntent } from "@/lib/paylabs/withdrawal/gateway-burn-signer";
import { submitGatewayTransfer, keccak256Json } from "@/lib/paylabs/withdrawal/gateway-transfer";
import { validateAmount, validateFeeCap } from "@/lib/paylabs/withdrawal/validate";
import { createWithdrawal, getWithdrawal, updateWithdrawal } from "@/lib/paylabs/withdrawal/ledger";
import { explorerUrl } from "@/lib/paylabs/withdrawal/explorer";
import { GATEWAY_MINTER_ADDRESS } from "@/lib/paylabs/withdrawal/gateway-types";
import type { WithdrawalStatus } from "@/lib/paylabs/withdrawal/gateway-types";

const _require = createRequire(import.meta.url);

const TERMINAL_STATES = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED", "STUCK"]);
const SUCCESS_STATES = new Set(["COMPLETE", "CONFIRMED"]);

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

async function pollDcwTx(txId: string, maxAttempts = 60, intervalMs = 5000): Promise<{
  state: string;
  txHash: string | null;
}> {
  const client = getDcwClient();
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await client.getTransaction({ id: txId });
      const tx = resp?.data?.transaction;
      const state = tx?.state || "UNKNOWN";
      if (TERMINAL_STATES.has(state)) {
        return { state, txHash: tx?.txHash || null };
      }
    } catch {
      // continue polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { state: "TIMEOUT", txHash: null };
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

    // 9. Compute burn intent hash
    const burnIntentHash = await keccak256Json(estimate.burnIntent);

    // 10. Store canonical BurnIntent in ledger
    const { row, error: createError } = await createWithdrawal({
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

    const withdrawalId = row.id;

    // 11. Sign BurnIntent using dedicated Gateway signer (2-field domain)
    let burnSignature: string;
    try {
      burnSignature = await signGatewayBurnIntent(walletId, estimate.burnIntent);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "signing_failed", errorMessage: msg.slice(0, 300) });
      return NextResponse.json({ ok: false, error: "BurnIntent signing failed" }, { status: 502 });
    }

    await updateWithdrawal(withdrawalId, { status: "burn_signed" });

    // 12. Submit signed BurnIntent to Gateway
    const transferResult = await submitGatewayTransfer({
      burnIntent: estimate.burnIntent,
      signature: burnSignature,
    });

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

    // 13. Estimate gatewayMint fee using actual attestation
    let mintIdempotencyKey = crypto.randomUUID();
    let mediumFee: string | undefined;
    try {
      const client = getDcwClient();
      const feeEstimate = await client.estimateContractExecutionFee({
        source: { walletId },
        contractAddress: GATEWAY_MINTER_ADDRESS,
        abiFunctionSignature: "gatewayMint(bytes,bytes)",
        abiParameters: [transferResult.attestation, transferResult.operatorSignature],
      });
      mediumFee = feeEstimate?.data?.medium?.networkFee;
    } catch {
      // Fee estimation failed — proceed anyway (Circle may sponsor gas)
    }

    // 14. Execute gatewayMint
    let mintTxId: string | undefined;
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
      mintTxId = mintTx?.data?.id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "mint_submission_failed", errorMessage: msg.slice(0, 300) });
      return NextResponse.json({ ok: false, error: "Gateway mint submission failed" }, { status: 502 });
    }

    if (!mintTxId) {
      await updateWithdrawal(withdrawalId, { status: "failed", errorCode: "mint_no_tx_id", errorMessage: "Circle returned no transaction ID for mint" });
      return NextResponse.json({ ok: false, error: "Mint transaction failed" }, { status: 502 });
    }

    await updateWithdrawal(withdrawalId, {
      status: "mint_submitted",
      mintIdempotencyKey,
      circleTransactionId: mintTxId,
      gasPreflightOk: !!mediumFee,
      gasPreflightFee: mediumFee,
    });

    // 15. Poll mint transaction
    const txResult = await pollDcwTx(mintTxId);

    if (SUCCESS_STATES.has(txResult.state)) {
      await updateWithdrawal(withdrawalId, {
        status: "finalized",
        txHash: txResult.txHash || undefined,
        explorerUrl: explorerUrl(txResult.txHash) || undefined,
      });
    } else if (txResult.state === "TIMEOUT") {
      await updateWithdrawal(withdrawalId, { status: "reconciliation_required", errorCode: "mint_poll_timeout" });
    } else {
      await updateWithdrawal(withdrawalId, {
        status: "failed",
        errorCode: "mint_tx_failed",
        errorMessage: `Circle mint transaction: ${txResult.state}`,
        txHash: txResult.txHash || undefined,
      });
    }

    // 16. Return safe response
    const { row: finalRow } = await getWithdrawal(withdrawalId, "dcw", session.sub);
    return NextResponse.json({ ok: true, ...safeResponse(finalRow || row) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/withdraw] Error:", msg.slice(0, 200));
    return NextResponse.json({ ok: false, error: "Withdrawal failed" }, { status: 500 });
  }
}
