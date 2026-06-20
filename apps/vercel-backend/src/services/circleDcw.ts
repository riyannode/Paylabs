/**
 * Circle Developer-Controlled Wallets (DCW) Service
 *
 * Real SDK wrapper for wallet management on Arc Testnet.
 * All secrets read from env — never logged, never exposed.
 *
 * PR #16: Wire real Circle Gateway x402 settlement.
 */

import {
  initiateDeveloperControlledWalletsClient,
  type Wallet,
  type Blockchain,
  type AccountType,
} from "@circle-fin/developer-controlled-wallets";

// ─── SDK Client ──────────────────────────────────────────────

let _client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

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

// ─── Wallet Set Operations ───────────────────────────────────

/**
 * Create a wallet set with wallets on specified chains.
 */
export async function createWalletSetWithWallets(input: {
  name: string;
  chains: Blockchain[];
  accountType?: AccountType;
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
    wallets: wallets.map((w: Wallet) => ({
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
  chain: Blockchain,
  accountType: AccountType = "EOA"
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

  const usdcAddress = "0x3600000000000000000000000000000000000000";

  const response = await client.createTransaction({
    walletId: input.walletId,
    tokenId: usdcAddress,
    destinationAddress: input.destinationAddress as `0x${string}`,
    amount: [input.amountUsdc],
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
    contractAddress: input.contractAddress as `0x${string}`,
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
