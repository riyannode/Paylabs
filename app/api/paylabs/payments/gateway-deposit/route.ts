// POST /api/paylabs/payments/gateway-deposit
//
// ⚠️  Direct USDC ERC-20 transfer to Gateway Wallet does NOT work.
//     Must call approve() + deposit() on-chain via DCW contract execution.
//
// Uses raw callData encoding (verified working pattern from circleDcw.ts).

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require(
  "@circle-fin/developer-controlled-wallets"
);

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret)
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

/** Encode approve(address,uint256) calldata */
function encodeApprove(spender: string, amount: string): string {
  const selector = "0x095ea7b3";
  const addr = spender.toLowerCase().replace("0x", "").padStart(64, "0");
  const amt = BigInt(amount).toString(16).padStart(64, "0");
  return `${selector}${addr}${amt}`;
}

/** Encode deposit(address,uint256) calldata */
function encodeDeposit(token: string, amount: string): string {
  const selector = "0x47e7ef24";
  const addr = token.toLowerCase().replace("0x", "").padStart(64, "0");
  const amt = BigInt(amount).toString(16).padStart(64, "0");
  return `${selector}${addr}${amt}`;
}

export async function POST(req: NextRequest) {
  let body: { walletId?: string; amountUsdc?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.walletId || !body.amountUsdc) {
    return NextResponse.json(
      { ok: false, error: "walletId and amountUsdc required" },
      { status: 400 }
    );
  }

  const amount = parseFloat(body.amountUsdc);
  if (isNaN(amount) || amount <= 0) {
    return NextResponse.json(
      { ok: false, error: "amountUsdc must be > 0" },
      { status: 400 }
    );
  }

  const amountAtomic = Math.round(amount * 1_000_000).toString();

  try {
    const client = getClient();

    // Step 1: approve(GatewayWallet, amount) on USDC contract
    const approveCalldata = encodeApprove(GATEWAY_WALLET, amountAtomic);
    const approveResp = await client.createContractExecutionTransaction({
      walletId: body.walletId,
      contractAddress: USDC_ARC,
      callData: approveCalldata as `0x${string}`,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: `gw-approve-${body.walletId}-${Date.now()}`,
    });

    const approveTx = approveResp.data;
    if (!approveTx?.id) {
      return NextResponse.json(
        { ok: false, error: "Approve failed — no tx ID", detail: approveResp.data },
        { status: 500 }
      );
    }

    // Step 2: deposit(USDC, amount) on Gateway contract
    const depositCalldata = encodeDeposit(USDC_ARC, amountAtomic);
    const depositResp = await client.createContractExecutionTransaction({
      walletId: body.walletId,
      contractAddress: GATEWAY_WALLET,
      callData: depositCalldata as `0x${string}`,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: `gw-deposit-${body.walletId}-${Date.now()}`,
    });

    const depositTx = depositResp.data;
    if (!depositTx?.id) {
      return NextResponse.json(
        { ok: false, error: "Deposit failed — no tx ID", detail: depositResp.data },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      approveTxId: approveTx.id,
      approveStatus: approveTx.state || "INITIATED",
      depositTxId: depositTx.id,
      depositStatus: depositTx.state || "INITIATED",
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: e.message || String(e),
        code: e.code,
        status: e.status,
        response: e.response?.data,
      },
      { status: 500 }
    );
  }
}
