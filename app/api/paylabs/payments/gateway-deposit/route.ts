// POST /api/paylabs/payments/gateway-deposit
import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function POST(req: NextRequest) {
  let body: { walletId?: string; amountUsdc?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  if (!body.walletId || !body.amountUsdc) return NextResponse.json({ ok: false, error: "walletId and amountUsdc required" }, { status: 400 });

  const amount = parseFloat(body.amountUsdc);
  if (isNaN(amount) || amount <= 0) return NextResponse.json({ ok: false, error: "amountUsdc must be > 0" }, { status: 400 });

  const amountAtomic = Math.round(amount * 1_000_000).toString();

  try {
    const client = getClient();

    // Step 1: approve
    const approveResp = await client.createContractExecutionTransaction({
      walletId: body.walletId,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [GATEWAY_WALLET, amountAtomic],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: `gw-approve-${body.walletId}-${Date.now()}`,
    });

    const approveTx = approveResp.data;
    if (!approveTx?.id) return NextResponse.json({ ok: false, error: "Approve failed", detail: approveResp.data }, { status: 500 });

    // Step 2: deposit
    const depositResp = await client.createContractExecutionTransaction({
      walletId: body.walletId,
      contractAddress: GATEWAY_WALLET,
      abiFunctionSignature: "deposit(address,uint256)",
      abiParameters: [USDC_ARC, amountAtomic],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: `gw-deposit-${body.walletId}-${Date.now()}`,
    });

    const depositTx = depositResp.data;
    if (!depositTx?.id) return NextResponse.json({ ok: false, error: "Deposit failed", detail: depositResp.data }, { status: 500 });

    return NextResponse.json({
      ok: true,
      approveTxId: approveTx.id, approveStatus: approveTx.state || "INITIATED",
      depositTxId: depositTx.id, depositStatus: depositTx.state || "INITIATED",
    });
  } catch (e: any) {
    // Return full error detail for debugging
    return NextResponse.json({
      ok: false,
      error: e.message || String(e),
      code: e.code,
      status: e.status,
      response: e.response?.data,
    }, { status: 500 });
  }
}
