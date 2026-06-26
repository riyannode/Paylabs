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
const AMOUNT = "20000000"; // 20 USDC atomic (6 decimals)

// Step 1: Approve Gateway to spend USDC
const approveSelector = "0x095ea7b3";
const paddedGateway = GATEWAY.slice(2).padStart(64, "0");
const paddedAmount = BigInt(AMOUNT).toString(16).padStart(64, "0");
const approveCalldata = `${approveSelector}${paddedGateway}${paddedAmount}`;

console.log("Step 1: Approve Gateway to spend 20 USDC...");
try {
  const approveTx = await client.createTransaction({
    walletId,
    contractAddress: USDC,
    callData: approveCalldata,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  console.log("Approve TX:", approveTx.data?.id, approveTx.data?.state);

  // Poll approve
  const approveId = approveTx.data?.id;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await client.getTransaction({ id: approveId });
    console.log(`  [${i+1}] approve: ${s.data?.transaction?.state}`);
    if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(s.data?.transaction?.state)) {
      if (s.data?.transaction?.state !== "COMPLETE") {
        console.log("Approve failed!", JSON.stringify(s.data?.transaction));
        process.exit(1);
      }
      console.log("Approve complete!");
      break;
    }
  }
} catch (e) {
  console.log("Approve error:", e.code, e.message?.slice(0, 200));
  process.exit(1);
}

// Step 2: Deposit USDC to Gateway
const depositSelector = "0x47e7ef24";
const paddedUsdc = USDC.slice(2).padStart(64, "0");
const depositCalldata = `${depositSelector}${paddedUsdc}${paddedAmount}`;

console.log("\nStep 2: Deposit 20 USDC to Gateway...");
try {
  const depositTx = await client.createTransaction({
    walletId,
    contractAddress: GATEWAY,
    callData: depositCalldata,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  console.log("Deposit TX:", depositTx.data?.id, depositTx.data?.state);

  const depId = depositTx.data?.id;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await client.getTransaction({ id: depId });
    const st = s.data?.transaction?.state;
    console.log(`  [${i+1}] deposit: ${st} hash=${s.data?.transaction?.txHash?.slice(0,16) || "pending"}`);
    if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(st)) {
      console.log("Deposit result:", st, "txHash:", s.data?.transaction?.txHash);
      break;
    }
  }
} catch (e) {
  console.log("Deposit error:", e.code, e.message?.slice(0, 200));
}

// Step 3: Check Gateway balance
console.log("\nChecking Gateway balance...");
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: "USDC",
    sources: [{ depositor: "0x1c5d4cF204e980912E8d9F90d8493AF20BFf682D", chain: "ARC-TESTNET" }],
  }),
});
const gwData = await gwResp.json();
const arcBalance = gwData.balances?.find(b => b.domain === 0 || b.domain === "ARC-TESTNET");
console.log("Gateway balance:", gwData.balances?.map(b => `domain=${b.domain} bal=${b.balance}`).join(", "));
