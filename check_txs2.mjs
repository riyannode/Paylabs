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

// Check what methods are available
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter(m => m.includes('ransaction') || m.includes('tx') || m.includes('Tx'));
console.log("Transaction methods:", methods);

// Try listTransactions
if (client.listTransactions) {
  const txs = await client.listTransactions({ walletIds: ["8d550f90-7b73-59c7-a774-d0fc89135dc4"] });
  console.log("Txs:", JSON.stringify(txs.data?.transactions?.length));
}

// Get the failed deposit tx details
try {
  const tx = await client.getTransaction({ id: "9d4aadd3-6e49-5a76-add3-1cdb140500d3" });
  console.log("\nDeposit tx detail:", JSON.stringify(tx.data?.transaction, null, 2));
} catch(e) { console.log("Tx detail error:", e.message); }
