/**
 * Circle User-Controlled Wallet (UCW) — Backend API wrappers.
 *
 * SECURITY: CIRCLE_API_KEY stays server-side. Never expose to client.
 */

import { initiateUserControlledWalletsClient } from "@circle-fin/user-controlled-wallets";
import type { Blockchain } from "@circle-fin/user-controlled-wallets";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// SDK singleton
// ---------------------------------------------------------------------------

let _client: ReturnType<typeof initiateUserControlledWalletsClient> | null = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.CIRCLE_API_KEY;
    if (!apiKey) throw new Error("CIRCLE_API_KEY not set");
    _client = initiateUserControlledWalletsClient({ apiKey });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARC_TESTNET_BLOCKCHAIN = "MATIC-AMOY" as Blockchain;
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET_ARC_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_REST_BASE = "https://gateway-api-testnet.circle.com/v1";
const ARC_TESTNET_DOMAIN = 26;

// ---------------------------------------------------------------------------
// Device Token (social login prerequisite)
// ---------------------------------------------------------------------------

export async function createDeviceToken(deviceId: string) {
  const client = getClient();
  const resp = await client.createDeviceTokenForSocialLogin({ deviceId });
  return {
    deviceToken: resp.data?.deviceToken,
    deviceEncryptionKey: resp.data?.deviceEncryptionKey,
  };
}

// ---------------------------------------------------------------------------
// Email device token (Email OTP prerequisite)
// ---------------------------------------------------------------------------

export async function createEmailDeviceToken(deviceId: string, email: string) {
  const client = getClient();
  const resp = await client.createDeviceTokenForEmailLogin({ deviceId, email });
  return {
    deviceToken: resp.data?.deviceToken,
    deviceEncryptionKey: resp.data?.deviceEncryptionKey,
  };
}

// ---------------------------------------------------------------------------
// User token (PIN auth — creates a 60-min session token)
// ---------------------------------------------------------------------------

export async function createUserToken(userId: string) {
  const client = getClient();
  const resp = await client.createUserToken({ userId });
  return {
    userToken: resp.data?.userToken,
  };
}

// ---------------------------------------------------------------------------
// User initialization / wallet creation
// ---------------------------------------------------------------------------

export async function initializeUser(userToken: string) {
  const client = getClient();
  try {
    const resp = await client.createUserPinWithWallets({
      userToken,
      blockchains: [ARC_TESTNET_BLOCKCHAIN],
      accountType: "EOA",
    });
    return { challengeId: resp.data?.challengeId ?? null, alreadyExists: false };
  } catch (err: unknown) {
    const error = err as { code?: number };
    if (error.code === 155106) {
      return { challengeId: null, alreadyExists: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wallet listing
// ---------------------------------------------------------------------------

export async function listWallets(userToken: string) {
  const client = getClient();
  const resp = await client.listWallets({ userToken });
  const wallets = resp.data?.wallets ?? [];
  return wallets.map((w) => ({
    id: w.id,
    address: w.address,
    blockchain: w.blockchain,
    state: w.state,
  }));
}

// ---------------------------------------------------------------------------
// Token balance
// ---------------------------------------------------------------------------

export async function getWalletTokenBalance(walletId: string, userToken: string) {
  const client = getClient();
  const resp = await client.getWalletTokenBalance({ walletId, userToken });
  const balances = resp.data?.tokenBalances ?? [];
  return balances.map((b) => ({
    token: b.token?.symbol ?? "unknown",
    amount: b.amount,
  }));
}

// ---------------------------------------------------------------------------
// signTypedData challenge (for x402 EIP-712 signing)
// ---------------------------------------------------------------------------

export async function createSignTypedDataChallenge(
  userToken: string,
  walletId: string,
  data: Record<string, unknown>,
) {
  const client = getClient();
  const resp = await client.signTypedData({
    userToken,
    walletId,
    data: data as unknown as string,
  });
  return { challengeId: resp.data?.challengeId };
}

// ---------------------------------------------------------------------------
// Contract execution challenge (for Gateway deposit: approve + deposit)
// ---------------------------------------------------------------------------

export async function createApproveChallenge(
  userToken: string,
  walletId: string,
  amountAtomic: string,
) {
  const client = getClient();
  const approveSelector = "0x095ea7b3";
  const paddedGateway = GATEWAY_WALLET_ARC_TESTNET.slice(2).padStart(64, "0");
  const paddedAmount = BigInt(amountAtomic).toString(16).padStart(64, "0");
  const callData = `${approveSelector}${paddedGateway}${paddedAmount}` as `0x${string}`;

  const resp = await client.createUserTransactionContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress: USDC_ARC_TESTNET,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  return { challengeId: resp.data?.challengeId };
}

export async function createDepositChallenge(
  userToken: string,
  walletId: string,
  amountAtomic: string,
) {
  const client = getClient();
  const depositSelector = "0x47e7ef24";
  const paddedUsdc = USDC_ARC_TESTNET.slice(2).padStart(64, "0");
  const paddedAmount = BigInt(amountAtomic).toString(16).padStart(64, "0");
  const callData = `${depositSelector}${paddedUsdc}${paddedAmount}` as `0x${string}`;

  const resp = await client.createUserTransactionContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress: GATEWAY_WALLET_ARC_TESTNET,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  return { challengeId: resp.data?.challengeId };
}

// ---------------------------------------------------------------------------
// Gateway balance (permissionless REST)
// ---------------------------------------------------------------------------

export async function getGatewayBalance(walletAddress: string) {
  const resp = await fetch(`${GATEWAY_REST_BASE}/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: ARC_TESTNET_DOMAIN, depositor: walletAddress.toLowerCase() }],
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gateway balance API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const balance = data.balances?.[0]?.balance ?? "0";
  return { balance, domain: ARC_TESTNET_DOMAIN };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  USDC_ARC_TESTNET,
  GATEWAY_WALLET_ARC_TESTNET,
  ARC_TESTNET_BLOCKCHAIN,
  ARC_TESTNET_DOMAIN,
};
