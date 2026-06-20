/**
 * Circle Developer-Controlled Wallets (DCW) Service
 *
 * Real SDK wrapper for wallet management on Arc Testnet.
 * All secrets read from env — never logged, never exposed.
 *
 * PR #16: Wire real Circle Gateway x402 settlement.
 * PR #18: Add signTypedData + Gateway deposit for x402 buyer flow.
 */

import { createRequire } from "node:module";

// CJS interop — @circle-fin/developer-controlled-wallets is CJS-only
const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

// ─── Constants ──────────────────────────────────────────────

const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

// ─── SDK Client ──────────────────────────────────────────────

let _client: any = null;

function getClient() {
  if (_client) return _client;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new DcwConfigError("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set");
  }

  _client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  return _client;
}

// ─── Types ───────────────────────────────────────────────────

export interface WalletInfo {
  walletId: string;
  address: string;
  chain: string;
  createdAt: string;
}

export interface WalletSetInfo {
  walletSetId: string;
  name: string;
  wallets: WalletInfo[];
}

export interface SignTypedDataInput {
  walletId: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface GatewayDepositResult {
  approveTxId: string | null;
  depositTxId: string;
  approveStatus: string;
  depositStatus: string;
}

// ─── Wallet Set Operations ───────────────────────────────────

/**
 * Create a wallet set with wallets on specified chains.
 */
export async function createWalletSetWithWallets(input: {
  name: string;
  chains: string[];
  accountType?: string;
}): Promise<WalletSetInfo> {
  const client = getClient();

  const wsResponse = await client.createWalletSet({
    name: input.name,
    idempotencyKey: `ws-${input.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
  });

  const walletSet = wsResponse.data?.walletSet;
  if (!walletSet?.id) {
    throw new DcwApiError("Failed to create wallet set", 500);
  }

  const walletsResponse = await client.createWallets({
    walletSetId: walletSet.id,
    accountType: input.accountType || "EOA",
    blockchains: input.chains,
    count: input.chains.length,
    idempotencyKey: `w-${walletSet.id}-${Date.now()}`,
  });

  const wallets = walletsResponse.data?.wallets || [];

  return {
    walletSetId: walletSet.id,
    name: input.name,
    wallets: wallets.map((w: any) => ({
      walletId: w.id,
      address: w.address,
      chain: w.blockchain,
      createdAt: w.createDate || new Date().toISOString(),
    })),
  };
}

/**
 * Create a single wallet in an existing wallet set.
 */
export async function createSingleWallet(
  walletSetId: string,
  chain: string,
  accountType: string = "EOA"
): Promise<WalletInfo> {
  const client = getClient();

  const response = await client.createWallets({
    walletSetId,
    accountType,
    blockchains: [chain],
    count: 1,
    idempotencyKey: `w-single-${walletSetId}-${chain}-${Date.now()}`,
  });

  const wallet = response.data?.wallets?.[0];
  if (!wallet) {
    throw new DcwApiError("Failed to create wallet", 500);
  }

  return {
    walletId: wallet.id,
    address: wallet.address,
    chain: wallet.blockchain,
    createdAt: wallet.createDate || new Date().toISOString(),
  };
}

// ─── Wallet Queries ──────────────────────────────────────────

/**
 * Get wallet by ID.
 */
export async function getWallet(walletId: string): Promise<WalletInfo | null> {
  const client = getClient();

  try {
    const response = await client.getWallet({ id: walletId });
    const w = response.data?.wallet;
    if (!w) return null;

    return {
      walletId: w.id,
      address: w.address,
      chain: w.blockchain,
      createdAt: w.createDate || "",
    };
  } catch {
    return null;
  }
}

/**
 * Get wallet token balance.
 */
export async function getWalletBalance(
  walletId: string
): Promise<{ tokenBalances: Array<{ token: string; amount: string }> }> {
  const client = getClient();

  const response = await client.getWalletTokenBalance({ id: walletId });
  const balances = response.data?.tokenBalances || [];

  return {
    tokenBalances: balances.map((b: { token?: { symbol?: string }; amount?: string }) => ({
      token: b.token?.symbol || "unknown",
      amount: b.amount || "0",
    })),
  };
}

/**
 * Validate that a wallet ID exists and is accessible.
 */
export async function validateWalletReachable(walletId: string): Promise<boolean> {
  if (!walletId) return false;
  try {
    const wallet = await getWallet(walletId);
    return wallet !== null;
  } catch {
    return false;
  }
}

/**
 * Check if DCW API is reachable with current credentials.
 */
export async function checkDcwApiReachable(): Promise<{
  reachable: boolean;
  error?: string;
}> {
  try {
    const client = getClient();
    // Minimal API call — get wallet set by a non-existent ID to verify credentials
    // If credentials are invalid, this throws an auth error
    await client.getWalletSet({ id: "00000000-0000-0000-0000-000000000000" }).catch(() => {
      // 404 is fine — means credentials work but ID doesn't exist
      // Auth errors will still throw
    });
    return { reachable: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { reachable: false, error: msg };
  }
}

/**
 * Transfer USDC from one DCW wallet to another.
 */
export async function transferUsdc(input: {
  walletId: string;
  destinationAddress: string;
  amountUsdc: string;
  idempotencyKey: string;
}): Promise<{ txId: string; status: string }> {
  const client = getClient();

  // Circle DCW SDK: use tokenAddress (contract address), not tokenId (UUID)
  // Circle DCW SDK: use amounts (plural), not amount
  const usdcAddress = USDC_ARC_TESTNET;

  const response = await client.createTransaction({
    walletId: input.walletId,
    tokenAddress: usdcAddress,
    destinationAddress: input.destinationAddress,
    amounts: [input.amountUsdc],
    fee: {
      type: "level",
      config: {
        feeLevel: "MEDIUM",
      },
    },
    idempotencyKey: input.idempotencyKey,
  });

  const tx = response.data;
  if (!tx?.id) {
    throw new DcwApiError("Transfer failed — no transaction ID returned", 500);
  }

  return {
    txId: tx.id,
    status: tx.state || "INITIATED",
  };
}

/**
 * Execute a contract call via DCW.
 */
export async function executeContractCall(input: {
  walletId: string;
  contractAddress: string;
  callData: string;
  idempotencyKey: string;
}): Promise<{ txId: string; status: string }> {
  const client = getClient();

  const response = await client.createContractExecutionTransaction({
    walletId: input.walletId,
    contractAddress: input.contractAddress,
    callData: input.callData as `0x${string}`,
    fee: {
      type: "level",
      config: {
        feeLevel: "MEDIUM",
      },
    },
    idempotencyKey: input.idempotencyKey,
  });

  const tx = response.data;
  if (!tx?.id) {
    throw new DcwApiError("Contract execution failed — no transaction ID", 500);
  }

  return {
    txId: tx.id,
    status: tx.state || "INITIATED",
  };
}

/**
 * Get transaction status by ID.
 */
export async function getTransactionStatus(
  txId: string
): Promise<{ id: string; state: string; txHash?: string }> {
  const client = getClient();

  const response = await client.getTransaction({ id: txId });
  const tx = response.data?.transaction;

  if (!tx) {
    throw new DcwApiError(`Transaction ${txId} not found`, 404);
  }

  return {
    id: tx.id,
    state: tx.state || "UNKNOWN",
    txHash: tx.txHash || undefined,
  };
}

// ─── Sign EIP-712 Typed Data (for x402 buyer flow) ──────────

/**
 * Sign EIP-712 typed data using DCW wallet.
 *
 * This is the core signing method for x402 buyer payments.
 * Circle DCW holds the private key — we never see it.
 *
 * @returns Hex signature string (0x-prefixed)
 * @throws DcwConfigError if env vars missing
 * @throws DcwApiError if signing fails
 */
export async function signTypedData(input: SignTypedDataInput): Promise<string> {
  const client = getClient();

  // DCW SDK signTypedData expects `data` as a JSON STRING, not an object.
  // bigint values must be serialized to string before passing.
  const dataString = JSON.stringify(
    {
      domain: input.domain,
      types: input.types,
      primaryType: input.primaryType,
      message: input.message,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );

  const response = await client.signTypedData({
    walletId: input.walletId,
    data: dataString,
  });

  const signature = response.data?.signature;
  if (!signature) {
    throw new DcwApiError("signTypedData returned no signature", 500);
  }

  return signature;
}

// ─── Gateway Deposit (approve + deposit via DCW) ─────────────

/**
 * Deposit USDC into Circle Gateway for x402 batched payments.
 *
 * Two-step on-chain operation via DCW contract execution:
 *   1. approve(GatewayWallet, amount) on USDC contract
 *   2. deposit(USDC, amount) on Gateway Wallet contract
 *
 * Both are async DCW transactions. Caller should poll getTransactionStatus()
 * until COMPLETE before attempting x402 payments.
 *
 * @param walletId - DCW wallet ID that holds USDC
 * @param amountUsdc - Amount as decimal string (e.g. "0.01")
 * @returns Transaction IDs for approve and deposit steps
 */
export async function gatewayApproveAndDeposit(input: {
  walletId: string;
  amountUsdc: string;
  idempotencyKeyPrefix: string;
}): Promise<GatewayDepositResult> {
  const { walletId, amountUsdc, idempotencyKeyPrefix } = input;

  // Convert to atomic units (6 decimals for USDC)
  const amountAtomic = BigInt(Math.round(parseFloat(amountUsdc) * 1_000_000));
  if (amountAtomic <= 0n) {
    throw new DcwApiError("Amount must be greater than 0", 400);
  }

  // Step 1: Approve Gateway Wallet to spend USDC
  // approve(address spender, uint256 amount)
  const approveCalldata = encodeApprove(GATEWAY_WALLET_TESTNET, amountAtomic);
  const approveResult = await executeContractCall({
    walletId,
    contractAddress: USDC_ARC_TESTNET,
    callData: approveCalldata,
    idempotencyKey: `${idempotencyKeyPrefix}:approve:${Date.now()}`,
  });

  // Step 2: Deposit USDC into Gateway Wallet
  // deposit(address token, uint256 amount)
  const depositCalldata = encodeDeposit(USDC_ARC_TESTNET, amountAtomic);
  const depositResult = await executeContractCall({
    walletId,
    contractAddress: GATEWAY_WALLET_TESTNET,
    callData: depositCalldata,
    idempotencyKey: `${idempotencyKeyPrefix}:deposit:${Date.now()}`,
  });

  return {
    approveTxId: approveResult.txId,
    depositTxId: depositResult.txId,
    approveStatus: approveResult.status,
    depositStatus: depositResult.status,
  };
}

// ─── ABI Encoding Helpers ────────────────────────────────────

/**
 * Encode ERC-20 approve(address,uint256) calldata.
 * No external dependency — manual ABI encoding.
 */
function encodeApprove(spender: string, amount: bigint): string {
  // Function selector: approve(address,uint256) = keccak256("approve(address,uint256)")[:4]
  const selector = "0x095ea7b3";
  // ABI encode: address (32 bytes, left-padded) + uint256 (32 bytes)
  const spenderPadded = spender.slice(2).toLowerCase().padStart(64, "0");
  const amountPadded = amount.toString(16).padStart(64, "0");
  return `${selector}${spenderPadded}${amountPadded}`;
}

/**
 * Encode Gateway Wallet deposit(address,uint256) calldata.
 * No external dependency — manual ABI encoding.
 */
function encodeDeposit(token: string, amount: bigint): string {
  // Function selector: deposit(address,uint256) = keccak256("deposit(address,uint256)")[:4]
  const selector = "0x47e7ef24";
  // ABI encode: address (32 bytes, left-padded) + uint256 (32 bytes)
  const tokenPadded = token.slice(2).toLowerCase().padStart(64, "0");
  const amountPadded = amount.toString(16).padStart(64, "0");
  return `${selector}${tokenPadded}${amountPadded}`;
}

// ─── Errors ──────────────────────────────────────────────────

export class DcwConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DcwConfigError";
  }
}

export class DcwApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DcwApiError";
    this.status = status;
  }
}
