import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
const USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const AMOUNT = "19990000"; // 19.99 USDC atomic (6 decimals)

async function pollTx(txId, label) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await client.getTransaction({ id: txId });
    const st = s.data?.transaction?.state;
    const hash = s.data?.transaction?.txHash;
    console.log(`  [${i+1}] ${label}: ${st} ${hash ? "hash="+hash.slice(0,16) : ""}`);
    if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(st)) return { state: st, tx: s.data?.transaction };
  }
  return { state: "TIMEOUT" };
}

// Approve already done, just deposit
console.log("Depositing 19.99 USDC to Gateway...");
const depositTx = await client.createContractExecutionTransaction({
  walletId,
  contractAddress: GATEWAY,
  abiFunctionSignature: "deposit(address,uint256)",
  abiParameters: [USDC, AMOUNT],
  fee: { type: "level", config: { feeLevel: "LOW" } },
  idempotencyKey: randomUUID(),
});
console.log("TX:", depositTx.data?.id);
const result = await pollTx(depositTx.data?.id, "deposit");
console.log("\nResult:", result.state);
if (result.tx?.txHash) console.log("txHash:", result.tx.txHash);

// Check Gateway balance
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
  if (b.balance !== "0") console.log(`  domain=${b.domain} balance=${b.balance} pending=${b.pendingBatch}`);
}
if (!gwData.balances?.some(b => b.balance !== "0")) console.log("  All zero");
