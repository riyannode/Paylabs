import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";

const privateKey = process.argv[2];
const messageFile = process.argv[3];

const message = readFileSync(messageFile, "utf-8");
const account = privateKeyToAccount(privateKey);

const client = createWalletClient({
  account,
  chain: arcTestnet,
  transport: http(),
});

const signature = await client.signMessage({ message });
writeFileSync("/tmp/siwe_result.json", JSON.stringify({ address: account.address, signature, message }));
console.log("Signed with:", account.address);
console.log("Signature:", signature.slice(0, 20) + "...");
