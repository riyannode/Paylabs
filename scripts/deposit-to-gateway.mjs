import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets");

const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC = "0x3600000000000000000000000000000000000000";
const BLOCKCHAIN = "ARC-TESTNET";
const DEPOSIT_AMOUNT = "1000000"; // 1 USDC = 1_000_000 (6 decimals)

const API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET;
const DEPOSITOR_WALLET_ADDRESS = process.env.DEPOSITOR_WALLET_ADDRESS;

if (!API_KEY || !ENTITY_SECRET || !DEPOSITOR_WALLET_ADDRESS) {
  throw new Error("Missing env vars");
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: API_KEY,
  entitySecret: ENTITY_SECRET,
});

async function waitForTx(txId, label) {
  const terminal = new Set(["COMPLETE", "CONFIRMED", "FAILED", "DENIED", "CANCELLED"]);
  for (let i = 0; i < 60; i++) {
    const { data } = await client.getTransaction({ id: txId });
    const state = data?.transaction?.state;
    console.log(`  ${label}: state=${state}`);
    if (state && terminal.has(state)) {
      if (state !== "COMPLETE" && state !== "CONFIRMED") {
        throw new Error(`${label} failed: state=${state}`);
      }
      return data.transaction;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`${label} timeout`);
}

async function main() {
  console.log(`Depositor: ${DEPOSITOR_WALLET_ADDRESS}`);
  console.log(`Amount: 5 USDC`);

  // Step 1: Approve
  console.log("\n1. Approving USDC...");
  const approve = await client.createContractExecutionTransaction({
    walletAddress: DEPOSITOR_WALLET_ADDRESS,
    blockchain: BLOCKCHAIN,
    contractAddress: USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [GATEWAY_WALLET, DEPOSIT_AMOUNT],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const approveId = approve.data?.id;
  if (!approveId) throw new Error("Failed to create approve tx: " + JSON.stringify(approve));
  console.log(`  Approve TX ID: ${approveId}`);
  await waitForTx(approveId, "Approve");

  // Step 2: Deposit
  console.log("\n2. Depositing to Gateway Wallet...");
  const deposit = await client.createContractExecutionTransaction({
    walletAddress: DEPOSITOR_WALLET_ADDRESS,
    blockchain: BLOCKCHAIN,
    contractAddress: GATEWAY_WALLET,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [USDC, DEPOSIT_AMOUNT],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });

  const depositId = deposit.data?.id;
  if (!depositId) throw new Error("Failed to create deposit tx: " + JSON.stringify(deposit));
  console.log(`  Deposit TX ID: ${depositId}`);
  await waitForTx(depositId, "Deposit");

  console.log("\n✅ 5 USDC deposited to Gateway!");
  console.log("Balance may take a few seconds to update.");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
