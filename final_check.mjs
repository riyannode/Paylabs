import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const env = {};
for (const line of readFileSync("/root/Paylabs/.env.check", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)/);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); env[m[1].trim()]=v; }
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const walletId = "8d550f90-7b73-59c7-a774-d0fc89135dc4";
const bal = await client.getWalletTokenBalance({ id: walletId });
for (const t of bal.data?.tokenBalances || []) {
  console.log(`${t.token?.symbol} (${t.token?.standard || "native"}): amount=${t.amount} decimals=${t.token?.decimals}`);
}

// Also check ARC explorer for this wallet
const addr = "0x1c5d4cf204e980912e8d9f90d8493af20bff682d";
console.log("\nWallet:", addr);
console.log("USDC contract: 0x3600000000000000000000000000000000000000");
console.log("Gateway: 0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
