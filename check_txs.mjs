import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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

// Get recent transactions
try {
  const txs = await client.getTransactions({ walletIds: [walletId], pageSize: 10 });
  const list = txs.data?.transactions || [];
  console.log(`Transactions (${list.length}):`);
  for (const tx of list) {
    console.log(`  ${tx.id?.slice(0,8)} | ${tx.state} | ${tx.amounts?.[0]} | ${tx.token?.symbol} | to=${tx.destinationAddress?.slice(0,10)}... | hash=${tx.txHash?.slice(0,12) || "none"}`);
  }
} catch(e) { console.log("Error:", e.message); }

// Also try Gateway balance check with correct format
console.log("\nGateway balance check...");
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: "USDC",
    sources: [{ address: "0x1c5d4cf204e980912e8d9f90d8493af20bff682d", chain: "ARC-TESTNET" }],
  }),
});
const gwData = await gwResp.json();
console.log("Gateway:", JSON.stringify(gwData));
