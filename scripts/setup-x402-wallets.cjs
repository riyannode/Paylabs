const { createRequire } = require("module");
const path = require("path");
const req = createRequire(path.join(__dirname, "package.json"));
const mod = req("@circle-fin/developer-controlled-wallets");

// Load env from .env.local
const fs = require("fs");
const envFile = path.join(__dirname, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [k, ...v] = trimmed.split("=");
      const val = v.join("=").trim().replace(/^["']|["']$/g, "");
      if (!process.env[k.trim()]) process.env[k.trim()] = val;
    }
  }
}

const client = mod.initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

const WALLET_SET = "a9b3344d-378f-522b-8512-d0f1e4be2277";
const USDC = "0x3600000000000000000000000000000000000000";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

async function main() {
  // Step 1: List existing wallets
  console.log("=== Listing existing wallets ===");
  const listResp = await client.listWallets({ walletSetIds: [WALLET_SET] });
  const wallets = listResp.data?.wallets || [];
  console.log(`Found ${wallets.length} wallets`);
  for (const w of wallets) {
    console.log(`  ${w.id} -> ${w.address}`);
  }

  // Step 2: Check which roles need new wallets
  // Roles that need wallets NOT used as child service sellers
  // Child service sellers: 0x611dccb6 (wallet3), 0xc718c0d9 (wallet4), 0x84b2c86c (wallet5)
  const serviceSellerAddresses = new Set([
    "0x611dccb6061d0462f8c54eab785d4411c8165149",
    "0xc718c0d97e43566f1e5082bee75ab96469b73611",
    "0x84b2c86c99578ea52d79c31869974793ac2261f2",
  ]);

  // Available wallets (not service sellers):
  // wallet1 (74951bca, 0xb5114ba7) - controller buyer ✓
  // wallet2 (e7c91f3c, 0x03e99590) - brain ✓
  // wallet6 (b54dd518, 0xcf61f412) - available
  // wallet7 (b532f414, 0x573ce5a2) - available
  // wallet8 (e2b06601, 0x308d8a1d) - available
  // wallet9 (ac604662, 0xb5bc0959) - available

  // We need 2 more wallets for settlement_memory_seller and settlement_memory_buyer
  const roles = {
    "controller_buyer": "74951bca-cea5-5ac1-9491-d9b63c1cb586",
    "brain_buyer": "e7c91f3c-c76b-5bd3-9941-c38c10771904",
    "brain_seller": "e7c91f3c-c76b-5bd3-9941-c38c10771904",
    "discovery_planner_seller": "b54dd518-f600-53b2-803d-a1acb563f62a",
    "discovery_planner_buyer": "b532f414-9f45-58c7-845d-5e9867e65582",
    "payment_decision_seller": "e2b06601-725a-5cd8-ab6c-5a272c4d058d",
    "payment_decision_buyer": "ac604662-176e-5915-8a04-b883a750b230",
    "settlement_memory_seller": null,
    "settlement_memory_buyer": null,
  };

  // Create 2 new wallets if needed
  const needed = Object.entries(roles).filter(([_, id]) => !id);
  if (needed.length > 0) {
    console.log(`\n=== Creating ${needed.length} new wallets ===`);
    for (const [role, _] of needed) {
      const createResp = await client.createWallets({
        walletSetId: WALLET_SET,
        blockchains: ["MATIC-AMOY"], // Arc Testnet uses same address format
        count: 1,
      });
      const newWallet = createResp.data?.wallets?.[0];
      if (newWallet) {
        roles[role] = newWallet.id;
        console.log(`  Created ${role}: ${newWallet.id} -> ${newWallet.address}`);
      } else {
        console.log(`  FAILED to create ${role}: ${JSON.stringify(createResp.data)}`);
      }
    }
  }

  // Step 3: Check Gateway balances
  console.log("\n=== Gateway Balances ===");
  const walletById = {};
  for (const w of wallets) walletById[w.id] = w;

  // Re-fetch wallets to include newly created
  const listResp2 = await client.listWallets({ walletSetIds: [WALLET_SET] });
  const allWallets = listResp2.data?.wallets || [];
  for (const w of allWallets) walletById[w.id] = w;

  for (const [role, walletId] of Object.entries(roles)) {
    if (!walletId) continue;
    const w = walletById[walletId];
    if (!w) { console.log(`  ${role}: wallet not found (${walletId})`); continue; }

    try {
      const resp = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "USDC", sources: [{ domain: 26, depositor: w.address.toLowerCase() }] }),
      });
      const data = await resp.json();
      const balance = data.balances?.[0]?.balance || "0";
      console.log(`  ${role}: ${w.address} = ${balance} USDC`);
    } catch (e) {
      console.log(`  ${role}: balance check failed - ${e.message}`);
    }
  }

  // Step 4: Output final wallet mapping
  console.log("\n=== Final Wallet Mapping ===");
  const output = {};
  for (const [role, walletId] of Object.entries(roles)) {
    const w = walletById[walletId];
    if (w) {
      output[role] = { walletId: w.id, address: w.address };
      console.log(`  ${role}: id=${w.id} addr=${w.address}`);
    }
  }

  // Write mapping to file for env setup
  fs.writeFileSync("/tmp/wallet-mapping.json", JSON.stringify(output, null, 2));
  console.log("\nMapping saved to /tmp/wallet-mapping.json");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
