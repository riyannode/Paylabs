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

// Check tx status
const txId = "9d4aadd3-6e49-5a76-add3-1cdb140500d3";
const tx = await client.getTransaction({ id: txId });
console.log("TX state:", tx.data?.transaction?.state);
console.log("TX hash:", tx.data?.transaction?.txHash?.slice(0,16) || "pending");

// Check Gateway balance
const addr = "0x1c5d4cf204e980912e8d9f90d8493af20bff682d";
const gwResp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "USDC", sources: [{ address: addr }] }),
});
const gwData = await gwResp.json();
console.log("Gateway balance:", JSON.stringify(gwData));
