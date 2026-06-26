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

// Get ERC20 USDC token address
const bal = await client.getWalletTokenBalance({ id: walletId });
const usdc = bal.data?.tokenBalances?.find(t => t.token?.symbol === "USDC" && t.token?.standard === "ERC20");
console.log("USDC balance:", usdc?.amount, "tokenAddress:", usdc?.token?.address, "id:", usdc?.token?.id?.slice(0,12));

// Use amounts (display units) per skill reference
try {
  console.log("\nDepositing 20 USDC to Gateway using amounts...");
  const tx = await client.createTransaction({
    walletId,
    destinationAddress: gatewayAddress,
    amounts: ["20"],
    tokenAddress: usdc.token.address,
    fee: { type: "level", config: { feeLevel: "LOW" } },
    idempotencyKey: randomUUID(),
  });
  console.log("TX:", JSON.stringify(tx.data, null, 2));

  const txId = tx.data?.id;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await client.getTransaction({ id: txId });
    const st = s.data?.transaction?.state;
    console.log(`[${i+1}] ${st} hash=${s.data?.transaction?.txHash?.slice(0,16) || "pending"}`);
    if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(st)) {
      console.log("Final:", st, s.data?.transaction?.txHash);
      break;
    }
  }
} catch (e) {
  console.log("Error:", e.code, e.message?.slice(0, 200));
}
