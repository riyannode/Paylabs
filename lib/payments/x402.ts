// x402 payment verification for Circle Gateway on Arc testnet
// EIP-3009 TransferWithAuthorization verification
//
// Architecture:
//   Client wallet signs TransferWithAuthorization (EIP-3009)
//   Client sends signed authorization to server
//   Server verifies signature + fields before creating unlock/receipt
//   Settlement via Circle Gateway batch (server-side, through Runner)

import { type Address, type Hex, isAddress, recoverAddress, keccak256, encodeAbiParameters, pad } from "viem";
import type { X402PaymentChallenge } from "@/types/paylabs";
import { createHash } from "node:crypto";

const USDC_ARC_TESTNET: Address = "0x3600000000000000000000000000000000000000";
const ARC_CHAIN_ID = 5042002;

export interface X402AuthorizationPayload {
  from: Address;
  to: Address;
  value: string; // base units (6 decimals)
  validAfter: string;
  validBefore: string;
  nonce: Hex; // bytes32
  signature: Hex; // 65-byte ECDSA signature (r + s + v)
}

export interface X402VerifyResult {
  valid: boolean;
  error?: string;
  recoveredAddress?: Address;
  paymentId?: string;
}

/**
 * Build x402 payment challenge for a lesson.
 */
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

/**
 * Compute the EIP-712 struct hash for TransferWithAuthorization.
 */
function computeTransferAuthStructHash(
  from: Address,
  to: Address,
  value: bigint,
  validAfter: bigint,
  validBefore: bigint,
  nonce: Hex
): Hex {
  // TransferWithAuthorization typehash
  const typeHash = keccak256(
    Buffer.from(
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    )
  );

  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [typeHash, from, to, value, validAfter, validBefore, nonce]
  );

  return keccak256(encoded);
}

/**
 * Compute the EIP-712 digest for TransferWithAuthorization.
 */
function computeEIP712Digest(
  structHash: Hex,
  chainId: number,
  verifyingContract: Address
): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        keccak256(Buffer.from("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(Buffer.from("USD Coin")),
        keccak256(Buffer.from("2")),
        BigInt(chainId),
        verifyingContract,
      ]
    )
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [domainSeparator, structHash]
    )
  );
}

/**
 * Verify a signed x402 TransferWithAuthorization.
 *
 * Checks:
 * 1. Receiver matches X402_RECEIVER_ADDRESS
 * 2. Amount matches expected lesson price
 * 3. Chain ID is 5042002 (Arc testnet)
 * 4. USDC contract address correct
 * 5. Authorization is currently valid (validAfter <= now <= validBefore)
 * 6. Nonce/payment_id is unique (not already used)
 * 7. Signature recovers to the `from` address
 * 8. `from` address is the paying user
 */
export async function verifyX402Authorization(
  auth: X402AuthorizationPayload,
  expectedAmountUsdc: number,
  expectedReceiver: Address,
  nonceExists: (nonce: string) => Promise<boolean>
): Promise<X402VerifyResult> {
  // 1. Validate addresses
  if (!isAddress(auth.from)) {
    return { valid: false, error: "Invalid from address" };
  }
  if (!isAddress(auth.to)) {
    return { valid: false, error: "Invalid to address" };
  }

  // 2. Receiver must match configured receiver
  if (auth.to.toLowerCase() !== expectedReceiver.toLowerCase()) {
    return {
      valid: false,
      error: `Receiver mismatch: expected ${expectedReceiver}, got ${auth.to}`,
    };
  }

  // 3. Amount must match
  const expectedBaseUnits = BigInt(Math.round(expectedAmountUsdc * 1_000_000));
  if (BigInt(auth.value) !== expectedBaseUnits) {
    return {
      valid: false,
      error: `Amount mismatch: expected ${expectedBaseUnits}, got ${auth.value}`,
    };
  }

  // 4. Authorization validity window
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter)) {
    return { valid: false, error: "Authorization not yet valid" };
  }
  if (now > Number(auth.validBefore)) {
    return { valid: false, error: "Authorization expired" };
  }

  // 5. Nonce uniqueness
  const nonceHash = createHash("sha256").update(auth.nonce).digest("hex");
  if (await nonceExists(nonceHash)) {
    return { valid: false, error: "Nonce already used (duplicate payment)" };
  }

  // 6. Recover signer from EIP-712 digest
  try {
    const structHash = computeTransferAuthStructHash(
      auth.from,
      auth.to,
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce
    );

    const digest = computeEIP712Digest(structHash, ARC_CHAIN_ID, USDC_ARC_TESTNET);

    const recovered = await recoverAddress({
      hash: digest,
      signature: auth.signature,
    });

    // 7. Signer must be the `from` address
    if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
      return {
        valid: false,
        error: `Signature mismatch: recovered ${recovered}, expected ${auth.from}`,
      };
    }

    return {
      valid: true,
      recoveredAddress: recovered,
      paymentId: nonceHash,
    };
  } catch (e: any) {
    return { valid: false, error: `Signature recovery failed: ${e.message}` };
  }
}

/**
 * Build the resource URL for x402 verification.
 * This binds the payment to a specific lesson content endpoint.
 */
export function buildResourceUrl(lessonId: string): string {
  const base = process.env.NEXT_PUBLIC_PAYLABS_APP_URL || "https://paylabs.vercel.app";
  return `${base}/api/paylabs/lessons/${lessonId}/content`;
}
