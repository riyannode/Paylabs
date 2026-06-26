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
console.log("Token balances:");
for (const t of tokens) {
  const amt = Number(t.amount) / Math.pow(10, t.token?.decimals || 6);
  console.log(`  ${t.token?.symbol} (${t.token?.standard}) decimals=${t.token?.decimals} amount=${t.amount} display=${amt} token_id=${t.token?.id?.slice(0,12)}...`);
}
