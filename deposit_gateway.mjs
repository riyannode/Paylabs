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
const walletAddress = "0x1c5d4cf204e980912e8d9f90d8493af20bff682d";

// Check current ERC20 USDC balance
const bal = await client.getWalletTokenBalance({ id: walletId });
const usdc = bal.data?.tokenBalances?.find(t => t.token?.symbol === "USDC" && t.token?.standard === "ERC20");
const usdcBalance = Number(usdc?.amount || 0) / Math.pow(10, usdc?.token?.decimals || 6);
console.log("USDC (ERC20) balance:", usdcBalance, "token_id:", usdc?.token?.id?.slice(0,12));

if (usdcBalance <= 0) {
  console.log("No USDC to deposit. Need faucet first.");
  process.exit(0);
}

// Check Gateway balance first
console.log("\nChecking Gateway balance...");
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ asset: "USDC", depositor: walletAddress }),
});
const gwData = await gwResp.json();
console.log("Gateway balance before:", JSON.stringify(gwData));

// Deposit to Gateway
// Need to transfer USDC to Gateway address
const gatewayAddress = "0x0077777d1A2D46037268E900BDb41980432B7f77"; // ARC-TESTNET Gateway
console.log("\nDepositing", usdcBalance, "USDC to Gateway...");

const tokenId = usdc.token.id;
const atomicAmount = usdc.amount; // use full balance

const tx = await client.createTransaction({
  walletId,
  destinationAddress: gatewayAddress,
  amount: [atomicAmount],
  tokenId,
  fee: { type: "level", config: { feeLevel: "LOW" } },
  idempotency: require("crypto").randomUUID(),
});

console.log("Transaction:", JSON.stringify(tx.data, null, 2));
