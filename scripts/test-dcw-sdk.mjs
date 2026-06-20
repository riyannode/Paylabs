/**
 * Minimal DCW SDK smoke test — prove initiateDeveloperControlledWalletsClient works.
 */
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

async function main() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  }

  console.log("Creating DCW client with initiateDeveloperControlledWalletsClient...");
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  console.log("Client created OK. Type:", typeof client);

  // Try fetching treasury wallet — proves auth works
  const walletId = process.env.PAYLABS_TREASURY_WALLET_ID;
  if (!walletId) {
    console.log("No PAYLABS_TREASURY_WALLET_ID — skipping wallet fetch.");
    console.log("✅ DCW SDK constructor works.");
    return;
  }

  console.log(`Fetching wallet ${walletId}...`);
  const resp = await client.getWallet({ id: walletId });
  const wallet = resp.data?.wallet;
  if (wallet) {
    console.log(`✅ Wallet found: ${wallet.address} (${wallet.blockchain})`);
    console.log(`   State: ${wallet.state}`);
  } else {
    console.log("⚠️ Wallet fetch returned no data:", JSON.stringify(resp.data));
  }
}

main().catch((e) => {
  console.error("❌ DCW SDK test failed:", e.message || e);
  process.exit(1);
});
