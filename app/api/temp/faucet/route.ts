// POST /api/temp/faucet — use Circle testnet faucet + deposit to Gateway
import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("Missing Circle creds");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function POST(req: NextRequest) {
  let body: { walletIds?: string[]; addresses?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const walletIds = body.walletIds || [];
  const addresses = body.addresses || [];
  const results: Array<{ walletId?: string; address?: string; step: string; status: string; detail?: any }> = [];

  try {
    const client = getClient();

    // Step 1: Use Circle's testnet faucet for each address
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      const walletId = walletIds[i] || "unknown";
      try {
        console.log(`[faucet] Requesting testnet tokens for ${address}...`);
        const faucetResp = await client.requestTestnetTokens({
          address,
          blockchain: "ARC-TESTNET",
          usdc: true,
        });
        results.push({ walletId, address, step: "faucet", status: "ok", detail: faucetResp.data });
      } catch (e: any) {
        results.push({
          walletId, address, step: "faucet", status: "error",
          detail: { message: e.message, code: e.code, status: e.status, response: e.response?.data },
        });
      }
    }

    // Step 2: Wait for faucet to settle
    await new Promise(r => setTimeout(r, 10000));

    // Step 3: Deposit to Gateway for each wallet
    for (const walletId of walletIds) {
      try {
        console.log(`[faucet] Depositing 0.001 USDC to Gateway for ${walletId}...`);
        const amountAtomic = "1000"; // 0.001 USDC

        const approveResp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC_ARC,
          abiFunctionSignature: "approve(address,uint256)",
          abiParameters: [GATEWAY_WALLET, amountAtomic],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: `faucet-approve-${walletId}-${Date.now()}`,
        });

        const approveTx = approveResp.data;
        if (!approveTx?.id) {
          results.push({ walletId, step: "approve", status: "failed", detail: approveResp.data });
          continue;
        }

        await new Promise(r => setTimeout(r, 8000));

        const depositResp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: GATEWAY_WALLET,
          abiFunctionSignature: "deposit(address,uint256)",
          abiParameters: [USDC_ARC, amountAtomic],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: `faucet-deposit-${walletId}-${Date.now()}`,
        });

        const depositTx = depositResp.data;
        results.push({ walletId, step: "deposit", status: depositTx?.id ? "ok" : "failed", detail: depositTx });
      } catch (e: any) {
        results.push({
          walletId, step: "deposit", status: "error",
          detail: { message: e.message, code: e.code, status: e.status, response: e.response?.data },
        });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
