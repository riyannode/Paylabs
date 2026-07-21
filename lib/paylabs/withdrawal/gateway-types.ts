/**
 * Gateway Withdrawal Types & Constants
 *
 * Single source of truth for Gateway contract addresses, EIP-712 types,
 * and domain configuration. Used by both DCW and UCW withdrawal flows.
 *
 * Arc Testnet only. USDC only. Same-chain only.
 */

// ─── Gateway Contract Addresses (Arc Testnet) ────────────────

/** Gateway WalletBatched contract on Arc Testnet */
export const GATEWAY_WALLET_ADDRESS =
  process.env.PAYLABS_GATEWAY_CONTRACT_ADDRESS ||
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/** GatewayMinter contract on Arc Testnet */
export const GATEWAY_MINTER_ADDRESS =
  process.env.PAYLABS_GATEWAY_MINTER_ADDRESS ||
  "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

/** USDC token contract on Arc Testnet */
export const USDC_CONTRACT_ADDRESS =
  process.env.PAYLABS_USDC_CONTRACT_ADDRESS ||
  process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS ||
  "0x3600000000000000000000000000000000000000";

/** Null address used for destinationCaller */
export const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── Chain Config ────────────────────────────────────────────

export const ARC_TESTNET_DOMAIN = 26;
export const ARC_TESTNET_CHAIN = "ARC-TESTNET";

// ─── Gateway API ─────────────────────────────────────────────

export const GATEWAY_TESTNET_URL =
  process.env.PAYLABS_GATEWAY_API_URL || "https://gateway-api-testnet.circle.com";

/** Application fee cap in atomic units (USDC, 6 decimals). Rejection threshold only. */
export const MAX_WITHDRAWAL_FEE_ATOMIC = "500000"; // 0.50 USDC

// ─── EIP-712 Types for Gateway BurnIntent ────────────────────

/**
 * Gateway EIP-712 domain — ONLY name + version.
 * This is DIFFERENT from the x402 adapter which uses name + version + chainId + verifyingContract.
 */
export const GATEWAY_EIP712_DOMAIN = {
  name: "GatewayWallet",
  version: "1",
} as const;

export const GATEWAY_EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

// ─── TransferSpec ────────────────────────────────────────────

export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: string;    // bytes32
  destinationContract: string; // bytes32
  sourceToken: string;       // bytes32
  destinationToken: string;  // bytes32
  sourceDepositor: string;   // bytes32
  destinationRecipient: string; // bytes32
  sourceSigner: string;      // bytes32
  destinationCaller: string; // bytes32
  value: string;             // atomic USDC
  salt: string;              // 0x + 32 random bytes
  hookData: string;          // "0x"
}

// ─── BurnIntent ──────────────────────────────────────────────

export interface BurnIntent {
  maxBlockHeight: string;
  maxFee: string;
  spec: TransferSpec;
}

// ─── Withdrawal States ───────────────────────────────────────

export type WithdrawalStatus =
  | "prepared"
  | "burn_signature_pending"
  | "burn_signed"
  | "gateway_submitted"
  | "attestation_received"
  | "mint_approval_pending"
  | "mint_submitted"
  | "finalized"
  | "failed"
  | "expired"
  | "reconciliation_required";

export type WalletMode = "dcw" | "creator_ucw";

// ─── Withdrawal Ledger Row ───────────────────────────────────

export interface WithdrawalRow {
  id: string;
  wallet_mode: WalletMode;
  owner_ref: string;
  wallet_id: string;
  wallet_address: string;
  amount_atomic: string;
  amount_usdc: number;
  idempotency_key: string;
  status: WithdrawalStatus;
  burn_intent: BurnIntent;
  burn_intent_hash: string;
  transfer_spec_hash: string | null;
  signing_challenge_id: string | null;
  gateway_transfer_id: string | null;
  attestation_hash: string | null;
  gateway_fee: string | null;
  gateway_expiration: number | null;
  mint_challenge_id: string | null;
  mint_idempotency_key: string | null;
  circle_transaction_id: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  gas_preflight_ok: boolean | null;
  gas_preflight_fee: string | null;
  gas_preflight_error: string | null;
  error_code: string | null;
  error_message: string | null;
  safe_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ─── Gateway Estimate Response ───────────────────────────────

export interface GatewayEstimateResponse {
  body: Array<{
    burnIntent: BurnIntent;
  }>;
  fees?: {
    total?: string;
    perIntent?: Array<{
      transferSpecHash: string;
    }>;
  };
}

// ─── Gateway Transfer Response ───────────────────────────────

export interface GatewayTransferResponse {
  transferId?: string;
  attestation: string;   // hex bytes
  signature: string;     // hex operator signature
}

// ─── DCW API Response Shapes ─────────────────────────────────

export interface WithdrawInitResponse {
  withdrawalId: string;
  status: WithdrawalStatus;
  amount: string;
  network: string;
  destination: string;
  transferId: string | null;
  circleTransactionId: string | null;
  txHash: string | null;
  explorerUrl: string | null;
}

export interface UcwWithdrawInitResponse {
  withdrawalId: string;
  status: WithdrawalStatus;
  signChallengeId: string;
}

export interface UcwSignResponse {
  withdrawalId: string;
  status: WithdrawalStatus;
  mintChallengeId: string;
}

export interface UcwMintResponse {
  withdrawalId: string;
  status: WithdrawalStatus;
  circleTransactionId: string | null;
  txHash: string | null;
  explorerUrl: string | null;
}
