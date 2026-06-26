import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

// Load env
const env = {};
for (const line of readFileSync("/root/Paylabs/.env.check", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1].trim()] = v;
  }
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

// Create wallet set
console.log("Creating wallet set...");
const ws = await client.createWalletSet({ name: "paylabs-discovery-planner-" + Date.now() });
const wsId = ws.data?.walletSet?.id;
console.log("Wallet set:", wsId);

// Create wallet on ARC-TESTNET
console.log("Creating wallet...");
const wallets = await client.createWallets({
  accountType: "EOA",
  blockchains: ["ARC-TESTNET"],
  count: 1,
  walletSetId: wsId,
  idempotencyKey: randomUUID(),
});

const w = wallets.data?.wallets?.[0];
if (!w) {
  console.error("Failed:", JSON.stringify(wallets));
  process.exit(1);
}

console.log("\n=== Discovery Planner Wallet ===");
console.log("Wallet ID:", w.id);
console.log("Address:", w.address);
console.log("Chain:", w.blockchain);
console.log("State:", w.state);
console.log("\nSet these in Vercel:");
console.log(`PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID=${w.id}`);
