/**
 * Deposit USDC from a Circle DCW EOA wallet into Circle Gateway.
 *
 * Two-step on-chain operation via DCW contract execution:
 *   1. approve(GatewayWallet, amount) on USDC contract
 *   2. deposit(USDC, amount) on Gateway Wallet contract
 *
 * Uses abiFunctionSignature + abiParameters (not raw callData).
 * No local private keys. No secrets printed.
 *
 * ⚠️  Direct USDC ERC-20 transfer to Gateway Wallet does NOT credit
 *     your Gateway balance. You MUST call deposit() on the Gateway
 *     contract. Skipping approve() will also fail.
 *
 * Usage:
 *   npx tsx scripts/deposit-to-gateway.mjs [amount_usdc]
 *   npx tsx scripts/deposit-to-gateway.mjs 0.01
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require(
  "@circle-fin/developer-controlled-wallets"
);

// ─── Constants ─────────────────────────────────────────────────

const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC_DECIMALS = 6;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;
const TERMINAL_STATES = new Set([
  "COMPLETE",
  "FAILED",
  "CANCELLED",
  "DENIED",
]);

// ─── Helpers ───────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function toAtomic(amountUsdc: string): bigint {
  const parsed = parseFloat(amountUsdc);
  if (isNaN(parsed) || parsed <= 0) {
    console.error(`❌ Invalid amount: ${amountUsdc}`);
    process.exit(1);
  }
  return BigInt(Math.round(parsed * 10 ** USDC_DECIMALS));
}

async function pollUntilTerminal(
  client: any,
  txId: string
): Promise<{ state: string; txHash?: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const resp = await client.getTransaction({ id: txId });
    const tx = resp.data?.transaction;
    const state = tx?.state || "UNKNOWN";

    if (TERMINAL_STATES.has(state)) {
      return { state, txHash: tx?.txHash || undefined };
    }

    process.stdout.write(`  ⏳ ${state}...\r`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { state: "TIMEOUT" };
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const amountUsdc = process.argv[2] || "0.01";
  const amountAtomic = toAtomic(amountUsdc);

  const apiKey = requireEnv("CIRCLE_API_KEY");
  const entitySecret = requireEnv("CIRCLE_ENTITY_SECRET");
  const walletId = requireEnv("PAYLABS_AGENT_EOA_WALLET_ID");
  const walletAddress = requireEnv("PAYLABS_AGENT_EOA_ADDRESS");

  console.log(`\n🔐 Gateway Deposit: ${amountUsdc} USDC`);
  console.log(`   Wallet: ${walletAddress}`);
  console.log(`   Gateway: ${GATEWAY_WALLET}`);
  console.log(`   Amount (atomic): ${amountAtomic}\n`);

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  // ── Step 1: Approve ──────────────────────────────────────────

  console.log("📝 Step 1/2: approve(GatewayWallet, amount)...");
  const approveResp = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: USDC_ARC_TESTNET,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [GATEWAY_WALLET, amountAtomic.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `gw-approve-${walletId}-${Date.now()}`,
  });

  const approveTxId = approveResp.data?.id;
  if (!approveTxId) {
    console.error("❌ Approve failed — no transaction ID returned");
    process.exit(1);
  }
  console.log(`   TX ID: ${approveTxId}`);

  const approveResult = await pollUntilTerminal(client, approveTxId);
  console.log(`   Status: ${approveResult.state}`);

  if (approveResult.state !== "COMPLETE") {
    console.error(
      `❌ Approve failed with state: ${approveResult.state}. Aborting.`
    );
    process.exit(1);
  }

  // ── Step 2: Deposit ──────────────────────────────────────────

  console.log("\n📝 Step 2/2: deposit(USDC, amount)...");
  const depositResp = await client.createContractExecutionTransaction({
    walletId,
    contractAddress: GATEWAY_WALLET,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [USDC_ARC_TESTNET, amountAtomic.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: `gw-deposit-${walletId}-${Date.now()}`,
  });

  const depositTxId = depositResp.data?.id;
  if (!depositTxId) {
    console.error("❌ Deposit failed — no transaction ID returned");
    process.exit(1);
  }
  console.log(`   TX ID: ${depositTxId}`);

  const depositResult = await pollUntilTerminal(client, depositTxId);
  console.log(`   Status: ${depositResult.state}`);

  if (depositResult.state !== "COMPLETE") {
    console.error(
      `❌ Deposit failed with state: ${depositResult.state}. Aborting.`
    );
    process.exit(1);
  }

  // ── Summary ──────────────────────────────────────────────────

  console.log("\n✅ Gateway deposit complete!");
  console.log(`   Wallet:    ${walletAddress}`);
  console.log(`   Amount:    ${amountUsdc} USDC`);
  console.log(`   Approve:   ${approveTxId} (${approveResult.state})`);
  console.log(`   Deposit:   ${depositTxId} (${depositResult.state})`);
  console.log(
    `\n⚠️  Note: Direct USDC transfer to Gateway does NOT work.`
  );
  console.log(
    `   You must call approve() + deposit() on-chain via DCW.\n`
  );
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
