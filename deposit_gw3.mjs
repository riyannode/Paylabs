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
const USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const AMOUNT = "20000000"; // 20 USDC (6 decimals)

async function pollTx(txId, label) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await client.getTransaction({ id: txId });
    const st = s.data?.transaction?.state;
    const hash = s.data?.transaction?.txHash;
    console.log(`  [${i+1}] ${label}: ${st} ${hash ? "hash="+hash.slice(0,16) : ""}`);
    if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(st)) return st;
  }
  return "TIMEOUT";
}

// Step 1: Approve
console.log("Step 1: Approve Gateway to spend 20 USDC...");
const approveTx = await client.createContractExecutionTransaction({
  walletId,
  contractAddress: USDC,
  abiFunctionSignature: "approve(address,uint256)",
  abiParameters: [GATEWAY, AMOUNT],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  idempotencyKey: randomUUID(),
});
console.log("Approve TX:", approveTx.data?.id);
const approveResult = await pollTx(approveTx.data?.id, "approve");
console.log("Approve result:", approveResult);
if (approveResult !== "COMPLETE") { console.log("ABORT"); process.exit(1); }

// Step 2: Deposit
console.log("\nStep 2: Deposit 20 USDC to Gateway...");
const depositTx = await client.createContractExecutionTransaction({
  walletId,
  contractAddress: GATEWAY,
  abiFunctionSignature: "deposit(address,uint256)",
  abiParameters: [USDC, AMOUNT],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  idempotencyKey: randomUUID(),
});
console.log("Deposit TX:", depositTx.data?.id);
const depositResult = await pollTx(depositTx.data?.id, "deposit");
console.log("Deposit result:", depositResult);

// Step 3: Gateway balance
console.log("\nGateway balance:");
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: "USDC",
    sources: [{ depositor: "0x1c5d4cF204e980912E8d9F90d8493AF20BFf682D", chain: "ARC-TESTNET" }],
  }),
});
const gwData = await gwResp.json();
for (const b of gwData.balances || []) {
  if (b.balance !== "0") console.log(`  domain=${b.domain} balance=${b.balance}`);
}
if (!gwData.balances?.some(b => b.balance !== "0")) console.log("  All zero");
