// x402 v2 payment verification for Circle Gateway on Arc testnet
// EIP-3009 TransferWithAuthorization with GatewayWalletBatched domain
//
// Architecture:
//   Client wallet signs TransferWithAuthorization (EIP-3009) with GatewayWalletBatched domain
//   Client sends signed authorization to server
//   Server verifies signature + fields before settlement
//   Settlement via Circle Gateway /v1/x402/settle (permissionless)

import { keccak256, recoverAddress, type Address, type Hex } from "viem";

// ─── Constants ───────────────────────────────────────────────

const ARC_CHAIN_ID = 5042002;
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000" as Address;
const GATEWAY_WALLET_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address;

// ─── x402 v2 EIP-712 Domain (GatewayWalletBatched) ──────────

const GATEWAY_DOMAIN = {
  name: "GatewayWalletBatched",
  version: "1",
  chainId: ARC_CHAIN_ID,
  verifyingContract: GATEWAY_WALLET_TESTNET,
};

const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

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
  const typeHash = keccak256(
    Buffer.from(
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    )
  );

  return keccak256(
    Buffer.concat([
      Buffer.from(typeHash.slice(2), "hex"),
      Buffer.from(from.slice(2).padStart(64, "0"), "hex"),
      Buffer.from(to.slice(2).padStart(64, "0"), "hex"),
      Buffer.from(value.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(validAfter.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(validBefore.toString(16).padStart(64, "0"), "hex"),
      Buffer.from(nonce.slice(2).padStart(64, "0"), "hex"),
    ])
  );
}

/**
 * Compute the EIP-712 domain separator for GatewayWalletBatched.
 */
function computeDomainSeparator(): Hex {
  const typeHash = keccak256(
    Buffer.from(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    )
  );
  const nameHash = keccak256(Buffer.from(GATEWAY_DOMAIN.name));
  const versionHash = keccak256(Buffer.from(GATEWAY_DOMAIN.version));

  return keccak256(
    Buffer.concat([
      Buffer.from(typeHash.slice(2), "hex"),
      Buffer.from(nameHash.slice(2), "hex"),
      Buffer.from(versionHash.slice(2), "hex"),
      Buffer.from(
        GATEWAY_DOMAIN.chainId.toString(16).padStart(64, "0"),
        "hex"
      ),
      Buffer.from(
        GATEWAY_DOMAIN.verifyingContract.slice(2).padStart(64, "0"),
        "hex"
      ),
    ])
  );
}

/**
 * Compute the full EIP-712 digest.
 */
function computeEIP712Digest(structHash: Hex): Hex {
  const domainSeparator = computeDomainSeparator();
  return keccak256(
    Buffer.concat([
      Buffer.from("1901", "hex"),
      Buffer.from(domainSeparator.slice(2), "hex"),
      Buffer.from(structHash.slice(2), "hex"),
    ])
  );
}

// ─── Types ───────────────────────────────────────────────────

export interface SignedAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  signature: `0x${string}`;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
  /** Hash of nonce+from for replay protection */
  paymentId?: string;
}

// ─── Verification ────────────────────────────────────────────

/**
 * Verify an EIP-3009 TransferWithAuthorization signature
 * using the GatewayWalletBatched EIP-712 domain (x402 v2).
 *
 * Checks:
 * 1. Signature recovery matches `from` address
 * 2. `value` matches expected amount
 * 3. `to` matches expected receiver
 * 4. Timing (validAfter/validBefore) is valid
 * 5. Nonce has not been used before (via nonceExists callback)
 */
export async function verifyX402Authorization(
  auth: SignedAuthorization,
  expectedAmountUsdc: number,
  expectedReceiver: `0x${string}`,
  nonceExists: (nonceHash: string) => Promise<boolean>
): Promise<VerifyResult> {
  try {
    const from = auth.from.toLowerCase() as Address;
    const to = auth.to.toLowerCase() as Address;
    const value = BigInt(auth.value);
    const validAfter = BigInt(auth.validAfter);
    const validBefore = BigInt(auth.validBefore);
    const nonce = auth.nonce as Hex;
    const signature = auth.signature as Hex;

    // 1. Validate expected amount
    const expectedValue = BigInt(Math.round(expectedAmountUsdc * 1_000_000));
    if (value !== expectedValue) {
      return {
        valid: false,
        error: `Value mismatch: expected ${expectedValue}, got ${value}`,
      };
    }

    // 2. Validate receiver
    if (to !== expectedReceiver.toLowerCase()) {
      return {
        valid: false,
        error: `Receiver mismatch: expected ${expectedReceiver}, got ${to}`,
      };
    }

    // 3. Validate timing
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < validAfter) {
      return { valid: false, error: "Authorization not yet valid (validAfter)" };
    }
    if (now >= validBefore) {
      return { valid: false, error: "Authorization expired (validBefore)" };
    }

    // 4. Check nonce replay
    const nonceHash = keccak256(
      Buffer.concat([
        Buffer.from(from.slice(2), "hex"),
        Buffer.from(nonce.slice(2), "hex"),
      ])
    );
    if (await nonceExists(nonceHash)) {
      return { valid: false, error: "Nonce already used" };
    }

    // 5. Recover signer from EIP-712 digest (GatewayWalletBatched domain)
    const structHash = computeTransferAuthStructHash(
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce
    );
    const digest = computeEIP712Digest(structHash);

    const recovered = await recoverAddress({
      hash: digest,
      signature,
    });

    if (recovered.toLowerCase() !== from) {
      return {
        valid: false,
        error: `Signature recovery failed: expected ${from}, got ${recovered}`,
      };
    }

    return { valid: true, paymentId: nonceHash };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `Signature recovery failed: ${msg}` };
  }
}

// ─── x402 v2 Payload Builder ────────────────────────────────

/**
 * Build the x402 v2 paymentPayload from a signed authorization.
 * Used by settleX402Payment to construct the Gateway /v1/x402/settle body.
 */
export function buildX402PaymentPayload(
  auth: SignedAuthorization,
  receiverAddress: string,
  amountBaseUnits: string
) {
  return {
    x402Version: 2,
    resource: {
      url: "/api/paylabs/discovery",
      description: "PayLabs discovery fee",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: `eip155:${ARC_CHAIN_ID}`,
      asset: USDC_ARC_TESTNET,
      amount: amountBaseUnits,
      payTo: receiverAddress,
      maxTimeoutSeconds: 604900,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: GATEWAY_WALLET_TESTNET,
      },
    },
    payload: {
      authorization: {
        from: auth.from,
        to: receiverAddress,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      signature: auth.signature,
    },
  };
}

/**
 * Build x402 v2 paymentRequirements for the facilitator.
 */
export function buildX402PaymentRequirements(
  receiverAddress: string,
  amountBaseUnits: string
) {
  return {
    scheme: "exact",
    network: `eip155:${ARC_CHAIN_ID}`,
    asset: USDC_ARC_TESTNET,
    amount: amountBaseUnits,
    payTo: receiverAddress,
    maxTimeoutSeconds: 604900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: GATEWAY_WALLET_TESTNET,
    },
  };
}

// ─── Re-export constants ─────────────────────────────────────

export { ARC_CHAIN_ID, USDC_ARC_TESTNET, GATEWAY_WALLET_TESTNET, GATEWAY_DOMAIN };
