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

for (const t of bal.data?.tokenBalances || []) {
  const dec = t.token?.decimals || 0;
  const raw = t.amount;
  const display = Number(raw) / Math.pow(10, dec);
  console.log(`${t.token?.symbol} (${t.token?.standard || "native"}): decimals=${dec} atomic=${raw} display=${display}`);
}

// If amount=20 and decimals=18, then 20/10^18 = 2e-17 (tiny)
// If amount=20 and decimals=6, then 20/10^6 = 0.00002 (tiny)
// For 20 USDC (dec=6), atomic should be 20000000
// So the user's 20 USDC might be on the 18-decimal native token?
