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
const bal = await client.getWalletTokenBalance({ id: walletId });
const tokens = bal.data?.tokenBalances || [];
console.log("All tokens:");
for (const t of tokens) {
  const dec = t.token?.decimals || 0;
  const display = Number(t.amount) / Math.pow(10, dec);
  console.log(`  ${t.token?.symbol} std=${t.token?.standard} dec=${dec} amount=${t.amount} display=${display} id=${t.token?.id?.slice(0,12)}`);
}

// Also check tx status
const txId = "9d4aadd3-6e49-5a76-add3-1cdb140500d3";
try {
  const txResp = await client.getTransaction({ id: txId });
  console.log("\nDeposit tx:", txResp.data?.transaction?.state, txResp.data?.transaction?.txHash?.slice(0,16));
} catch(e) { console.log("Tx check:", e.message); }
