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

const txId = "f7faa727-97d9-5dcc-a78e-5ee420564520";
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const s = await client.getTransaction({ id: txId });
  const tx = s.data?.transaction;
  console.log(`[${i+1}] ${tx?.state} hash=${tx?.txHash?.slice(0,16) || "pending"}`);
  if (["COMPLETE","FAILED","DENIED","CANCELLED"].includes(tx?.state)) {
    console.log("DONE:", tx?.state, "txHash:", tx?.txHash);
    break;
  }
}

// Check Gateway balance
console.log("\nChecking Gateway balance...");
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: "USDC",
    sources: [{ depositor: "0x1c5d4cf204e980912e8d9f90d8493af20bff682d", chain: "ARC-TESTNET" }],
  }),
});
console.log("Gateway:", await gwResp.text());
