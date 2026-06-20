import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

async function main() {
  // Check failed deposit tx
  const { data } = await client.getTransaction({ id: 'e2a4baa0-9b59-5ec4-a72d-5e1ef3e01ab6' });
  console.log('Failed tx:', JSON.stringify(data?.transaction, null, 2));

  // Check treasury wallet balance
  const walletId = '74951bca-cea5-5ac1-9491-d9b63c1cb586';
  const bal = await client.getWalletTokenBalance({ id: walletId });
  console.log('\nTreasury balances:', JSON.stringify(bal?.data?.tokenBalances, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
