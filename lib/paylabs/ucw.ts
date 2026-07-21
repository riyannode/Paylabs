/**
 * Circle User-Controlled Wallet (UCW) — Backend API wrappers.
 *
 * SECURITY: CIRCLE_API_KEY stays server-side. Never expose to client.
 * SECURITY: UCW session tokens (userToken, encryptionKey, deviceToken) are
 *           stored server-side in Supabase ucw_sessions table.
 *           Frontend only holds an httpOnly session ID cookie.
 */

import { initiateUserControlledWalletsClient } from "@circle-fin/user-controlled-wallets";
import type { Blockchain } from "@circle-fin/user-controlled-wallets";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Server-side UCW session store — Supabase-backed (production-safe)
// ---------------------------------------------------------------------------

export interface UcwServerSession {
  deviceId: string;
  deviceToken: string;
  deviceEncryptionKey: string;
  userToken: string;
  encryptionKey: string;
  walletId: string;
  walletAddress: string;
  authMethod: "google" | "email" | "pin" | "";
}

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL not configured");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function createSession(): Promise<string> {
  const id = randomUUID();
  const supabase = getSupabase();
  const empty: UcwServerSession = { deviceId: "", deviceToken: "", deviceEncryptionKey: "", userToken: "", encryptionKey: "", walletId: "", walletAddress: "", authMethod: "" };
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const { error } = await supabase.from("ucw_sessions").insert({ sid: id, data: empty, expires_at: expiresAt });
  if (error) throw new Error(`Session create failed: ${error.message}`);
  return id;
}

export async function getSession(id: string): Promise<UcwServerSession | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ucw_sessions")
    .select("data, expires_at")
    .eq("sid", id)
    .single();
  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await supabase.from("ucw_sessions").delete().eq("sid", id);
    return null;
  }
  return data.data as UcwServerSession;
}

export async function updateSession(id: string, patch: Partial<UcwServerSession>): Promise<UcwServerSession | null> {
  const supabase = getSupabase();
  // Read current, merge, write back
  const { data } = await supabase.from("ucw_sessions").select("data").eq("sid", id).single();
  if (!data) return null;
  const merged = { ...data.data, ...patch } as UcwServerSession;
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const { error } = await supabase.from("ucw_sessions").update({ data: merged, expires_at: expiresAt }).eq("sid", id);
  if (error) return null;
  return merged;
}

export async function deleteSession(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("ucw_sessions").delete().eq("sid", id);
}

/** Refresh session TTL — call on every successful session action. */
export async function refreshSession(id: string): Promise<void> {
  const supabase = getSupabase();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await supabase.from("ucw_sessions").update({ expires_at: expiresAt }).eq("sid", id);
}

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

/** Arc Testnet — Circle UCW native blockchain identifier */
const ARC_TESTNET_BLOCKCHAIN = "ARC-TESTNET" as Blockchain;
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET_ARC_TESTNET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const ARC_TESTNET_DOMAIN = 26;
const GATEWAY_MINTER_ADDRESS = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

// ---------------------------------------------------------------------------
// Device Token (Google social login prerequisite)
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
// User creation (PIN auth prerequisite)
// ---------------------------------------------------------------------------

export async function createUser(userId: string) {
  const client = getClient();
  const resp = await client.createUser({ userId });
  return {
    id: resp.data?.id,
    status: resp.data?.status,
    pinStatus: resp.data?.pinStatus,
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
    encryptionKey: resp.data?.encryptionKey,
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
// Gateway Withdrawal — UCW SDK wrappers
// ---------------------------------------------------------------------------

/**
 * Sign typed data for Gateway withdrawal.
 * @returns { challengeId } — the EIP-712 signing challenge ID
 */
export async function signTypedDataForGateway(
  userToken: string,
  walletId: string,
  data: Record<string, unknown> | string,
): Promise<{ challengeId: string }> {
  const client = getClient();
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  const resp = await client.signTypedData({ userToken, walletId, data: dataStr });
  const challengeId = resp.data?.challengeId;
  if (!challengeId) {
    throw new Error("signTypedData returned no challengeId");
  }
  return { challengeId };
}

/**
 * Create a Gateway mint challenge via contract execution.
 * @returns { challengeId } — the challenge ID to poll for completion
 */
export async function createGatewayMintChallenge(
  userToken: string,
  walletId: string,
  attestation: string,
  operatorSignature: string,
  idempotencyKey: string,
): Promise<{ challengeId: string }> {
  const client = getClient();
  const resp = await client.createUserTransactionContractExecutionChallenge({
    userToken,
    walletId,
    contractAddress: GATEWAY_MINTER_ADDRESS,
    abiFunctionSignature: "gatewayMint(bytes,bytes)",
    abiParameters: [attestation, operatorSignature],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey,
  });
  const challengeId = resp.data?.challengeId;
  if (!challengeId) {
    throw new Error("createGatewayMintChallenge returned no challengeId");
  }
  return { challengeId };
}

/**
 * Retrieve a user challenge by ID.
 * @returns correlationIds and status of the challenge
 */
export async function getUserChallenge(
  userToken: string,
  challengeId: string,
): Promise<{ correlationIds: string[]; status: string }> {
  const client = getClient();
  const resp = await client.getUserChallenge({ userToken, challengeId });
  const challenge = (resp.data as any)?.challenge;
  if (!challenge) {
    throw new Error(`getUserChallenge returned no data for ${challengeId}`);
  }
  return {
    correlationIds: challenge.correlationIds ?? [],
    status: challenge.status,
  };
}

/**
 * Get the status of a transaction.
 * @returns { state, txHash } of the transaction
 */
export async function getTransactionStatus(
  userToken: string,
  transactionId: string,
): Promise<{ state: string; txHash: string }> {
  const client = getClient();
  const resp = await client.getTransaction({ userToken, id: transactionId });
  const tx = (resp.data as any)?.transaction;
  if (!tx) {
    throw new Error(`getTransaction returned no data for ${transactionId}`);
  }
  return { state: tx.state, txHash: tx.txHash };
}

/**
 * Estimate the fee for a Gateway mint (contract execution).
 * @returns { low, medium, high } fee estimate levels
 */
export async function estimateMintFee(
  userToken: string,
  walletId: string,
  attestation: string,
  operatorSignature: string,
): Promise<{ low: unknown; medium: unknown; high: unknown }> {
  const client = getClient();
  const resp = await client.estimateContractExecutionFee({
    userToken,
    source: { walletId },
    contractAddress: GATEWAY_MINTER_ADDRESS,
    abiFunctionSignature: "gatewayMint(bytes,bytes)",
    abiParameters: [attestation, operatorSignature],
  });
  const data = resp.data as any;
  if (!data || data.low === undefined) {
    throw new Error("estimateContractExecutionFee returned no fee data");
  }
  return { low: data.low, medium: data.medium, high: data.high };
}

/**
 * Get token balances for a UCW wallet.
 * @returns array of { symbol, amount } for each token
 */
export async function getUcwWalletTokenBalance(
  userToken: string,
  walletId: string,
): Promise<Array<{ symbol: string; amount: string }>> {
  const client = getClient();
  const resp = await client.getWalletTokenBalance({ walletId, userToken });
  const balances = (resp.data as any)?.tokenBalances ?? [];
  return balances.map((b: any) => ({
    symbol: b.token?.symbol ?? "unknown",
    amount: b.amount,
  }));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  USDC_ARC_TESTNET,
  GATEWAY_WALLET_ARC_TESTNET,
  ARC_TESTNET_BLOCKCHAIN,
  ARC_TESTNET_DOMAIN,
  GATEWAY_MINTER_ADDRESS,
};
