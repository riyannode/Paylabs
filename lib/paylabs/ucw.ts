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
}

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase credentials not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function createSession(): Promise<string> {
  const id = randomUUID();
  const supabase = getSupabase();
  const empty: UcwServerSession = { deviceId: "", deviceToken: "", deviceEncryptionKey: "", userToken: "", encryptionKey: "", walletId: "", walletAddress: "" };
  const { error } = await supabase.from("ucw_sessions").insert({ sid: id, data: empty });
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
  const { error } = await supabase.from("ucw_sessions").update({ data: merged }).eq("sid", id);
  if (error) return null;
  return merged;
}

export async function deleteSession(id: string): Promise<void> {
  const supabase = getSupabase();
  await supabase.from("ucw_sessions").delete().eq("sid", id);
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
const GATEWAY_REST_BASE = "https://gateway-api-testnet.circle.com/v1";
const ARC_TESTNET_DOMAIN = 26;

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
//
// Circle UCW API requires `data` as a JSON STRING containing the full
// EIP-712 structure: { domain, types (WITH EIP712Domain), primaryType, message }.
// All uint256 values must be decimal strings, not hex.
// ---------------------------------------------------------------------------

export async function createSignTypedDataChallenge(
  userToken: string,
  walletId: string,
  data: Record<string, unknown>,
) {
  const client = getClient();
  // Ensure EIP712Domain is present in types — Circle API requires it
  const types = data.types as Record<string, unknown> | undefined;
  if (types && !types.EIP712Domain) {
    (data.types as Record<string, unknown>).EIP712Domain = [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ];
  }

  // Circle UCW API expects `data` as a JSON string
  const dataString = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  const resp = await client.signTypedData({
    userToken,
    walletId,
    data: dataString,
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
