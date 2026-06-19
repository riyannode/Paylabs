import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const PRIVATE_KEY = process.argv[2];
const MESSAGE = process.argv[3];

if (!PRIVATE_KEY || !MESSAGE) {
  console.error("Usage: node sign.mjs <privateKey> <message>");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);

const client = createWalletClient({
  account,
  chain: arcTestnet,
  transport: http(),
});

const signature = await client.signMessage({ message: MESSAGE });
console.log(JSON.stringify({ address: account.address, signature }));
