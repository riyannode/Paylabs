/**
 * Create PayLabs Agent Wallets via Circle DCW API
 * Uses createRequire for CJS interop.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CircleDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const WALLET_LABELS = [
  { label: "treasury", envId: "PAYLABS_TREASURY_WALLET_ID", envAddr: "PAYLABS_TREASURY_WALLET_ADDRESS" },
  { label: "reserve", envId: "PAYLABS_RESERVE_WALLET_ID", envAddr: "PAYLABS_RESERVE_WALLET_ADDRESS" },
  { label: "tutor_intake", envId: "PAYLABS_AGENT_WALLET_ID_TUTOR_INTAKE", envAddr: "PAYLABS_AGENT_WALLET_TUTOR_INTAKE" },
  { label: "intent_classifier", envId: "PAYLABS_AGENT_WALLET_ID_INTENT_CLASSIFIER", envAddr: "PAYLABS_AGENT_WALLET_INTENT_CLASSIFIER" },
  { label: "query_expander", envId: "PAYLABS_AGENT_WALLET_ID_QUERY_EXPANDER", envAddr: "PAYLABS_AGENT_WALLET_QUERY_EXPANDER" },
  { label: "discovery_ranker", envId: "PAYLABS_AGENT_WALLET_ID_DISCOVERY_RANKER", envAddr: "PAYLABS_AGENT_WALLET_DISCOVERY_RANKER" },
  { label: "source_quality_verifier", envId: "PAYLABS_AGENT_WALLET_ID_SOURCE_QUALITY_VERIFIER", envAddr: "PAYLABS_AGENT_WALLET_SOURCE_QUALITY_VERIFIER" },
  { label: "provenance_verifier", envId: "PAYLABS_AGENT_WALLET_ID_PROVENANCE_VERIFIER", envAddr: "PAYLABS_AGENT_WALLET_PROVENANCE_VERIFIER" },
  { label: "attribution_auditor", envId: "PAYLABS_AGENT_WALLET_ID_ATTRIBUTION_AUDITOR", envAddr: "PAYLABS_AGENT_WALLET_ATTRIBUTION_AUDITOR" },
];

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    console.error("ERROR: Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in env.");
    process.exit(1);
  }

  console.log("Creating PayLabs wallet set on ARC-TESTNET...\n");

  const client = new CircleDeveloperControlledWalletsClient({ apiKey, entitySecret });

  // Create wallet set
  const wsResponse = await client.createWalletSet({
    name: "PayLabs test wallet set",
    idempotencyKey: `paylabs-ws-${Date.now()}`,
  });

  const walletSet = wsResponse.data?.walletSet;
  if (!walletSet?.id) {
    console.error("ERROR: Failed to create wallet set.");
    console.error("Response:", JSON.stringify(wsResponse.data, null, 2));
    process.exit(1);
  }

  console.log(`Wallet set: ${walletSet.id}\n`);

  // Create 9 wallets
  const results = [];

  for (const wl of WALLET_LABELS) {
    try {
      const response = await client.createWallets({
        walletSetId: walletSet.id,
        accountType: "EOA",
        blockchains: ["ARC-TESTNET"],
        count: 1,
        idempotencyKey: `paylabs-${wl.label}-${Date.now()}`,
      });

      const wallet = response.data?.wallets?.[0];
      if (!wallet) {
        console.error(`  ✗ ${wl.label}: no wallet returned`);
        continue;
      }

      results.push({
        label: wl.label,
        walletId: wallet.id,
        address: wallet.address,
        chain: wallet.blockchain,
        createdAt: wallet.createDate || new Date().toISOString(),
      });

      console.log(`  ✓ ${wl.label}: ${wallet.address}`);
    } catch (e: any) {
      console.error(`  ✗ ${wl.label}: ${e.message || e}`);
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log("WALLET SUMMARY");
  console.log("═".repeat(80) + "\n");

  for (const r of results) {
    console.log(`${r.label}`);
    console.log(`  wallet_id: ${r.walletId}`);
    console.log(`  address:   ${r.address}`);
    console.log(`  chain:     ${r.chain}`);
    console.log(`  created:   ${r.createdAt}\n`);
  }

  console.log("═".repeat(80));
  console.log("VERCEL ENV VARS:");
  console.log("═".repeat(80) + "\n");

  for (const r of results) {
    const wl = WALLET_LABELS.find(w => w.label === r.label);
    if (wl) {
      console.log(`${wl.envId}=${r.walletId}`);
      console.log(`${wl.envAddr}=${r.address}`);
    }
  }

  console.log(`\nTotal: ${results.length} / ${WALLET_LABELS.length}`);
  if (results.length < WALLET_LABELS.length) process.exit(1);
}

main().catch((e: any) => { console.error("Fatal:", e.message || e); process.exit(1); });
