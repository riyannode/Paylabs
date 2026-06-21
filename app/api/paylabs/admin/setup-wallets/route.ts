// POST /api/paylabs/admin/setup-wallets
// Creates missing wallets, checks Gateway balances, deposits if needed
// DELETE THIS FILE AFTER SETUP

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";

export const maxDuration = 60;

const WALLET_SET_ID = "a9b3344d-378f-522b-8512-d0f1e4be2277";
const USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const APPROVE_SELECTOR = "0x095ea7b3";
const DEPOSIT_SELECTOR = "0x47e7ef24";

// Wallet roles that need wallets NOT used as child service sellers
// Child service sellers: wallet3 (0x611dccb6), wallet4 (0xc718c0d9), wallet5 (0x84b2c86c)
const ROLE_WALLET_MAP: Record<string, string | null> = {
  controller_buyer: "74951bca-cea5-5ac1-9491-d9b63c1cb586",     // wallet1
  brain_buyer: "e7c91f3c-c76b-5bd3-9941-c38c10771904",          // wallet2
  brain_seller: "e7c91f3c-c76b-5bd3-9941-c38c10771904",         // wallet2
  discovery_planner_seller: "b54dd518-f600-53b2-803d-a1acb563f62a",  // wallet6
  discovery_planner_buyer: "b532f414-9f45-58c7-845d-5e9867e65582",   // wallet7
  payment_decision_seller: "e2b06601-725a-5cd8-ab6c-5a272c4d058d",  // wallet8
  payment_decision_buyer: "ac604662-176e-5915-8a04-b883a750b230",   // wallet9
  settlement_memory_seller: null,  // needs creation
  settlement_memory_buyer: null,   // needs creation
};

async function getDcwClient() {
  const _require = createRequire(import.meta.url);
  const mod = _require("@circle-fin/developer-controlled-wallets");
  return mod.initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET,
  });
}

async function checkGatewayBalance(address: string): Promise<string> {
  const resp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ domain: 26, depositor: address.toLowerCase() }] }),
  });
  const data = await resp.json();
  return data.balances?.[0]?.balance || "0";
}

export async function POST(req: NextRequest) {
  try {
    const client = await getDcwClient();

    // List existing wallets
    const listResp = await client.listWallets({ walletSetIds: [WALLET_SET_ID] });
    const wallets: Array<{ id: string; address: string }> = listResp.data?.wallets || [];
    const walletById: Record<string, { id: string; address: string }> = {};
    for (const w of wallets) walletById[w.id] = w;

    const log: string[] = [];
    log.push(`Found ${wallets.length} existing wallets`);

    // Create missing wallets
    for (const [role, walletId] of Object.entries(ROLE_WALLET_MAP)) {
      if (walletId) continue;
      log.push(`Creating wallet for ${role}...`);
      const createResp = await client.createWallets({
        walletSetId: WALLET_SET_ID,
        blockchains: ["MATIC-AMOY"],
        count: 1,
      });
      const newWallet = createResp.data?.wallets?.[0];
      if (newWallet) {
        ROLE_WALLET_MAP[role] = newWallet.id;
        walletById[newWallet.id] = newWallet;
        log.push(`  Created: ${newWallet.id} -> ${newWallet.address}`);
      } else {
        log.push(`  FAILED: ${JSON.stringify(createResp.data)}`);
      }
    }

    // Check Gateway balances
    const balances: Record<string, { address: string; balance: string }> = {};
    for (const [role, walletId] of Object.entries(ROLE_WALLET_MAP)) {
      if (!walletId) continue;
      const w = walletById[walletId];
      if (!w) continue;
      const bal = await checkGatewayBalance(w.address);
      balances[role] = { address: w.address, balance: bal };
      log.push(`${role}: ${w.address} = ${bal} USDC`);
    }

    // Deposit to Gateway for wallets with low balance
    const DEPOSIT_AMOUNT = "0.000010"; // 10 USDC micro
    const deposits: Array<{ role: string; from: string; status: string }> = [];

    for (const [role, info] of Object.entries(balances)) {
      if (parseFloat(info.balance) >= 0.000005) continue; // enough

      const walletId = ROLE_WALLET_MAP[role]!;
      log.push(`Depositing ${DEPOSIT_AMOUNT} USDC to ${role}...`);

      try {
        // Step 1: Approve
        const amountAtomic = BigInt(Math.round(parseFloat(DEPOSIT_AMOUNT) * 1_000_000));
        const approveCalldata = `${APPROVE_SELECTOR}${GATEWAY_WALLET.slice(2).padStart(64, "0")}${amountAtomic.toString(16).padStart(64, "0")}`;

        const approveResp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: USDC,
          callData: approveCalldata as `0x${string}`,
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: crypto.randomUUID(),
        });
        const approveTxId = approveResp.data?.id;
        log.push(`  Approve tx: ${approveTxId}`);

        // Wait for approve to complete
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const txResp = await client.getTransaction({ id: approveTxId });
          const state = txResp.data?.transaction?.state;
          if (state === "COMPLETE") break;
          if (state === "FAILED") throw new Error("Approve tx failed");
        }

        // Step 2: Deposit
        const depositCalldata = `${DEPOSIT_SELECTOR}${USDC.slice(2).padStart(64, "0")}${amountAtomic.toString(16).padStart(64, "0")}`;

        const depositResp = await client.createContractExecutionTransaction({
          walletId,
          contractAddress: GATEWAY_WALLET,
          callData: depositCalldata as `0x${string}`,
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: crypto.randomUUID(),
        });
        const depositTxId = depositResp.data?.id;
        log.push(`  Deposit tx: ${depositTxId}`);

        // Wait for deposit
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const txResp = await client.getTransaction({ id: depositTxId });
          const state = txResp.data?.transaction?.state;
          if (state === "COMPLETE") break;
          if (state === "FAILED") throw new Error("Deposit tx failed");
        }

        deposits.push({ role, from: walletId, status: "deposited" });
        log.push(`  Deposited ${DEPOSIT_AMOUNT} USDC to ${role}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        deposits.push({ role, from: walletId, status: `failed: ${msg}` });
        log.push(`  Deposit failed: ${msg}`);
      }
    }

    // Output final mapping
    const mapping: Record<string, { walletId: string; address: string }> = {};
    for (const [role, walletId] of Object.entries(ROLE_WALLET_MAP)) {
      if (!walletId) continue;
      const w = walletById[walletId];
      if (w) mapping[role] = { walletId: w.id, address: w.address };
    }

    return NextResponse.json({
      ok: true,
      mapping,
      balances,
      deposits,
      log,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
