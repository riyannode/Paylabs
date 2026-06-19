// x402 payment challenge builder for Circle Gateway on Arc testnet
// Reuses EIP-3009 TransferWithAuthorization pattern from existing Paylabs backend

import type { X402PaymentChallenge } from "@/types/paylabs";

const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const ARC_CHAIN_ID = 5042002;

export function buildX402Challenge(
  receiverAddress: string,
  amountUsdc: number
): X402PaymentChallenge {
  const amountBaseUnits = BigInt(
    Math.round(amountUsdc * 1_000_000)
  ).toString();

  return {
    network: "arc-testnet",
    receiverAddress,
    amount: amountBaseUnits,
    token: USDC_ARC_TESTNET,
    chainId: ARC_CHAIN_ID,
    eip712Domain: {
      name: "USD Coin",
      version: "2",
      chainId: ARC_CHAIN_ID,
      verifyingContract: USDC_ARC_TESTNET,
    },
    typedData: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
  };
}
