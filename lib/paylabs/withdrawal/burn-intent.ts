/**
 * BurnIntent Construction
 *
 * Builds a TransferSpec and salt, ready for Gateway /v1/estimate.
 * Does NOT build the final BurnIntent — that comes from the estimate response.
 */

import { randomBytes } from "node:crypto";
import type { TransferSpec } from "./gateway-types";
import {
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_MINTER_ADDRESS,
  USDC_CONTRACT_ADDRESS,
  NULL_ADDRESS,
  ARC_TESTNET_DOMAIN,
} from "./gateway-types";

// ─── Address Encoding ────────────────────────────────────────

/** Encode an EVM address as bytes32 (pad to 64 hex chars) */
export function addressToBytes32(address: string): string {
  if (!address || !address.startsWith("0x") || address.length !== 42) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// ─── Salt ────────────────────────────────────────────────────

/** Generate a random bytes32 salt */
export function randomSalt(): string {
  return "0x" + randomBytes(32).toString("hex");
}

// ─── TransferSpec Builder ────────────────────────────────────

export interface BuildTransferSpecInput {
  /** DCW or UCW wallet address (the depositor AND recipient) */
  walletAddress: string;
  /** Amount in atomic USDC (string BigInt) */
  amountAtomic: string;
}

/**
 * Build a TransferSpec for Arc Testnet → Arc Testnet same-chain withdrawal.
 * source = destination = walletAddress (locked destination).
 */
export function buildTransferSpec(input: BuildTransferSpecInput): TransferSpec {
  const { walletAddress, amountAtomic } = input;

  return {
    version: 1,
    sourceDomain: ARC_TESTNET_DOMAIN,
    destinationDomain: ARC_TESTNET_DOMAIN,
    sourceContract: addressToBytes32(GATEWAY_WALLET_ADDRESS),
    destinationContract: addressToBytes32(GATEWAY_MINTER_ADDRESS),
    sourceToken: addressToBytes32(USDC_CONTRACT_ADDRESS),
    destinationToken: addressToBytes32(USDC_CONTRACT_ADDRESS),
    sourceDepositor: addressToBytes32(walletAddress),
    destinationRecipient: addressToBytes32(walletAddress),
    sourceSigner: addressToBytes32(walletAddress),
    destinationCaller: addressToBytes32(NULL_ADDRESS),
    value: amountAtomic,
    salt: randomSalt(),
    hookData: "0x",
  };
}
