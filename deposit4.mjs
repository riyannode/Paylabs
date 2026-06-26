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

// Dump full token structure
const bal = await client.getWalletTokenBalance({ id: walletId });
for (const t of bal.data?.tokenBalances || []) {
  console.log("Token:", JSON.stringify(t.token, null, 2));
  console.log("Amount:", t.amount, typeof t.amount);
  console.log("---");
}

// Try with tokenId + amounts (display units)
const erc20 = bal.data?.tokenBalances?.find(t => t.token?.standard === "ERC20");
if (erc20) {
  try {
    console.log("\nTransfer with tokenId + amounts...");
    const tx = await client.createTransaction({
      walletId,
      destinationAddress: gatewayAddress,
      amounts: [erc20.amount],  // "20" = 20 USDC display
      tokenId: erc20.token.id,
      fee: { type: "level", config: { feeLevel: "LOW" } },
      idempotencyKey: randomUUID(),
    });
    console.log("TX:", JSON.stringify(tx.data, null, 2));
  } catch (e) {
    console.log("Error:", e.code, e.message?.slice(0, 300));
  }
}
