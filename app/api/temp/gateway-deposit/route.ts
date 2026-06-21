// POST /api/temp/gateway-deposit — approve + deposit USDC to Gateway (no faucet)
import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const DEPOSIT_AMOUNT = "100000"; // 0.1 USDC in atomic units

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("Missing Circle creds");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function POST(req: NextRequest) {
  let body: { walletIds?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const walletIds = body.walletIds || [];
  if (!walletIds.length) return NextResponse.json({ ok: false, error: "No walletIds" }, { status: 400 });

  const results: Array<{ walletId: string; step: string; status: string; detail?: any }> = [];

  try {
    const client = getClient();

    // Step 1: Approve USDC spending for Gateway
    for (const walletId of walletIds) {
      try {
        console.log(`[deposit] Approving USDC for Gateway: ${walletId}`);
        const resp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC_ARC,
          abiFunctionSignature: "approve(address,uint256)",
          abiParameters: [GATEWAY_WALLET, DEPOSIT_AMOUNT],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: `deposit-approve-${walletId}-${Date.now()}`,
        });
        const tx = resp.data;
        results.push({ walletId, step: "approve", status: tx?.id ? "ok" : "failed", detail: tx });
      } catch (e: any) {
        results.push({ walletId, step: "approve", status: "error", detail: { message: e.message, code: e.code, response: e.response?.data } });
      }
    }

    // Wait for approve txs to settle
    await new Promise(r => setTimeout(r, 15000));

    // Step 2: Deposit to Gateway
    for (const walletId of walletIds) {
      try {
        console.log(`[deposit] Depositing to Gateway: ${walletId}`);
        const resp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: GATEWAY_WALLET,
          abiFunctionSignature: "deposit(address,uint256)",
          abiParameters: [USDC_ARC, DEPOSIT_AMOUNT],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: `deposit-deposit-${walletId}-${Date.now()}`,
        });
        const tx = resp.data;
        results.push({ walletId, step: "deposit", status: tx?.id ? "ok" : "failed", detail: tx });
      } catch (e: any) {
        results.push({ walletId, step: "deposit", status: "error", detail: { message: e.message, code: e.code, response: e.response?.data } });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
