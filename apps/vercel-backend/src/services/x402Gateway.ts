// x402/Gateway payment service
// Handles EIP-3009 TransferWithAuthorization signing, verification, and Gateway settlement

import { config } from "../config.js";

export interface X402Requirements {
  network: string;
  receiverAddress: string;
  amount: string;
  token: string;
  chainId: number;
  eip712Domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  typedData: Record<string, unknown>;
}

export interface X402VerificationResult {
  valid: boolean;
  paymentId?: string;
  authorizationHash?: string;
  error?: string;
}

export interface X402SettlementResult {
  accepted: boolean;
  paymentId: string;
  authorizationHash: string;
  settlementRef?: string;
  batchId?: string;
  batchPosition?: number;
  error?: string;
}

export function buildX402Requirements(purpose: string): X402Requirements {
  const amount = purpose === "ai_search"
    ? config.x402DefaultAmountUsdc
    : purpose === "content_access"
    ? config.x402DefaultAmountUsdc
    : config.maxSinglePaymentUsdc;

  // Convert USDC amount to base units (6 decimals)
  const amountBaseUnits = BigInt(Math.round(parseFloat(amount) * 1_000_000)).toString();

  return {
    network: config.x402Network,
    receiverAddress: config.x402ReceiverAddress,
    amount: amountBaseUnits,
    token: "0x3600000000000000000000000000000000000000", // USDC on Arc Testnet
    chainId: config.arcChainId,
    eip712Domain: {
      name: "USD Coin",
      version: "2",
      chainId: config.arcChainId,
      verifyingContract: "0x3600000000000000000000000000000000000000",
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

export async function verifyX402Authorization(
  _payload: Record<string, unknown>
): Promise<X402VerificationResult> {
  // TODO: Verify EIP-3009 TransferWithAuthorization signature
  // TODO: Call Circle Gateway facilitator to verify
  throw new Error("Not implemented yet");
}

export async function settleX402Payment(
  _paymentId: string,
  _authorizationHash: string
): Promise<X402SettlementResult> {
  // TODO: Submit to Gateway for batch settlement
  throw new Error("Not implemented yet");
}
