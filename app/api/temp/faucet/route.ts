// POST /api/temp/faucet — one-time use to fund buyer wallets via Circle testnet faucet + deposit to Gateway
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
  let body: { walletIds?: string[]; amountUsdc?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const walletIds = body.walletIds || [];
  const amountUsdc = body.amountUsdc || "0.001";
  const amountAtomic = Math.round(parseFloat(amountUsdc) * 1_000_000).toString();

  const results: Array<{ walletId: string; status: string; error?: string }> = [];

  try {
    const client = getClient();

    for (const walletId of walletIds) {
      try {
        // Step 1: Check wallet balance first
        const balResp = await client.getWalletBalance({ walletId });
        const balances = balResp.data?.tokenBalances || [];
        const usdcBal = balances.find((b: any) => b.token?.symbol === "USDC");
        const usdcAmount = usdcBal?.amount || "0";
        console.log(`[faucet] ${walletId}: USDC balance = ${usdcAmount}`);

        // Step 2: Try approve
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
          results.push({ walletId, status: "approve_failed", error: JSON.stringify(approveResp.data).slice(0, 200) });
          continue;
        }

        // Step 3: Wait a bit for approve to settle, then deposit
        await new Promise(r => setTimeout(r, 5000));

        const depositResp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: GATEWAY_WALLET,
          abiFunctionSignature: "deposit(address,uint256)",
          abiParameters: [USDC_ARC, amountAtomic],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: `faucet-deposit-${walletId}-${Date.now()}`,
        });

        const depositTx = depositResp.data;
        if (!depositTx?.id) {
          results.push({ walletId, status: "deposit_failed", error: JSON.stringify(depositResp.data).slice(0, 200) });
          continue;
        }

        results.push({ walletId, status: "ok", });
      } catch (e: any) {
        results.push({
          walletId,
          status: "error",
          error: e.message || String(e),
        });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message, results }, { status: 500 });
  }
}
