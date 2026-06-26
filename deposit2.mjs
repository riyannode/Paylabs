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
const erc20TokenId = "ef87c8c3-85de-598a-af50-c5135eecfa74";

try {
  console.log("Creating transfer...");
  const tx = await client.createTransaction({
    walletId,
    destinationAddress: gatewayAddress,
    amount: ["20000000"],
    tokenId: erc20TokenId,
    fee: { type: "level", config: { feeLevel: "LOW" } },
    idempotencyKey: randomUUID(),
  });
  console.log("TX:", JSON.stringify(tx.data, null, 2));
} catch (e) {
  console.log("Error name:", e.name);
  console.log("Error message:", e.message?.slice(0, 200));
  console.log("Error code:", e.code);
  if (e.status) console.log("HTTP status:", e.status);
}
