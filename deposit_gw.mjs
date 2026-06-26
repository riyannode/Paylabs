import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const env = {};
for (const line of readFileSync("/root/Paylabs/.env.check", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)/);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1].trim()] = v; }
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const walletId = "8d550f90-7b73-59c7-a774-d0fc89135dc4";
const gatewayAddress = "0x0077777d1A2D46037268E900BDb41980432B7f77";
const erc20TokenId = "ef87c8c3-85de-598a-af50-c5135eecfa74";

// 20 USDC = 20000000 atomic (6 decimals)
const atomicAmount = "20000000";

console.log("Depositing 20 USDC (20000000 atomic) to Gateway...");
const tx = await client.createTransaction({
  walletId,
  destinationAddress: gatewayAddress,
  amount: [atomicAmount],
  tokenId: erc20TokenId,
  fee: { type: "level", config: { feeLevel: "LOW" } },
  idempotencyKey: randomUUID(),
});

console.log("TX ID:", tx.data?.transaction?.id);
console.log("State:", tx.data?.transaction?.state);

// Poll until done
const txId = tx.data?.transaction?.id;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const status = await client.getTransaction({ id: txId });
  const state = status.data?.transaction?.state;
  const hash = status.data?.transaction?.txHash;
  console.log(`[${i+1}] state=${state} hash=${hash?.slice(0,16) || "pending"}`);
  if (state === "CONFIRMED" || state === "COMPLETE" || state === "FAILED") {
    console.log("Final:", JSON.stringify(status.data?.transaction, null, 2).slice(0, 500));
    break;
  }
}
