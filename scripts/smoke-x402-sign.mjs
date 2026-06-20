/**
 * Generate a valid x402 v2 TransferWithAuthorization signature for smoke testing.
 * Uses GatewayWalletBatched domain (not USD Coin).
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseUnits, toHex } from "viem";

const BACKEND = "http://localhost:3001";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;

// Generate test wallet
const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);
console.log(`Test wallet: ${account.address}`);

// x402 v2 EIP-712 domain: GatewayWalletBatched
const domain = {
  name: "GatewayWalletBatched",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: GATEWAY_WALLET,
};

const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const nonceBytes = new Uint8Array(32);
crypto.getRandomValues(nonceBytes);
const nonce = toHex(nonceBytes);

const now = Math.floor(Date.now() / 1000);
const validAfter = BigInt(now - 600);
const validBefore = BigInt(now + 604900); // x402 v2 requires 604900

const treasuryAddress = "0xb5114ba71523b2f08a56924ded4133b3dd77a57b";
const discoveryFeeValue = BigInt(parseUnits("0.001", 6)); // 0.001 USDC

const message = {
  from: account.address,
  to: treasuryAddress,
  value: discoveryFeeValue,
  validAfter,
  validBefore,
  nonce: nonce,
};

console.log(`\nSigning x402 v2 TransferWithAuthorization...`);
console.log(`  domain: GatewayWalletBatched / ${GATEWAY_WALLET}`);
console.log(`  from: ${message.from}`);
console.log(`  to: ${message.to}`);
console.log(`  value: ${discoveryFeeValue} (0.001 USDC)`);

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: "TransferWithAuthorization",
  message,
});

console.log(`  signature: ${signature.slice(0, 20)}...`);

// SMOKE: Valid signature → Gateway settle
console.log(`\n=== SMOKE: POST /discovery (valid x402 v2 sig) ===`);
const res = await fetch(`${BACKEND}/api/paylabs/payments/discovery`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    discoveryRunId: "00000000-0000-0000-0000-000000000099",
    userWallet: account.address,
    routeTier: "easy",
    signedAuthorization: {
      from: message.from,
      to: message.to,
      value: discoveryFeeValue.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    },
  }),
});

const result = await res.json();
console.log(`HTTP ${res.status}:`, JSON.stringify(result, null, 2));

// Checks
if (result.status === "paid" && !result.paymentRef) {
  console.error("❌ FAIL: Marked paid without real paymentRef!");
  process.exit(1);
}

if (result.status === "failed" && result.error?.includes("verification failed")) {
  console.error("❌ FAIL: Signature verification failed (should pass with v2 domain)!");
  process.exit(1);
}

console.log(`\n✅ Result: ${result.status}`);
if (result.paymentRef) console.log(`   paymentRef: ${result.paymentRef}`);
if (result.settlementRef) console.log(`   settlementRef: ${result.settlementRef}`);
if (result.error) console.log(`   error: ${result.error}`);
