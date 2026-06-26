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

console.log("=== Raw response ===");
for (const t of tokens) {
  console.log(JSON.stringify({
    symbol: t.token?.symbol,
    standard: t.token?.standard,
    decimals: t.token?.decimals,
    amount_raw: t.amount,
    amount_type: typeof t.amount,
    token_id: t.token?.id,
  }));
}

// Maybe amount is already display units?
console.log("\n=== If amount IS display units ===");
for (const t of tokens) {
  console.log(`${t.token?.symbol} (${t.token?.standard}): ${t.amount} USDC`);
}

// Check wallet address matches
console.log("\n=== Wallet info ===");
const wallet = await client.getWallet({ id: walletId });
console.log("address:", wallet.data?.wallet?.address);
console.log("chain:", wallet.data?.wallet?.blockchain);
console.log("state:", wallet.data?.wallet?.state);
