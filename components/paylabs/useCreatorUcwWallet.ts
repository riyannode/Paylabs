"use client";

/**
 * useCreatorUcwWallet — UCW wallet hook for Creator Dashboard.
 *
 * Extracted from paylabs-chat-client.tsx. Owns all Circle UCW wallet state,
 * SDK lifecycle, session restore, and wallet management handlers.
 *
 * Chat page uses DCW only. UCW lives here on the creator page.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { WalletState, WalletInfo, UcwBalance } from "@/components/paylabs/WalletConnectModal";

// ─── x402 Client Signing ────────────────────────────────────

const ARC_CHAIN_ID = 5042002;
const GATEWAY_VERIFIED_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

function randomNonce(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return `0x${Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function buildEip712Params(challenge: Record<string, unknown>, walletAddress: string) {
  const accepts = challenge.accepts as Array<Record<string, unknown>>;
  const requirement = accepts[0];
  const extra = requirement.extra as Record<string, string>;
  const amountAtomic = requirement.amount as string;
  const payTo = requirement.payTo as string;
  const maxTimeout = requirement.maxTimeoutSeconds as number;

  const now = Math.floor(Date.now() / 1000);
  const nonce = randomNonce();

  const domain = {
    name: extra.name || "GatewayWalletBatched",
    version: extra.version || "1",
    chainId: ARC_CHAIN_ID,
    verifyingContract: (extra.verifyingContract || GATEWAY_VERIFIED_CONTRACT) as `0x${string}`,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: walletAddress as `0x${string}`,
    to: payTo as `0x${string}`,
    value: amountAtomic,
    validAfter: "0",
    validBefore: String(now + maxTimeout),
    nonce,
  };

  return { domain, types, message, requirement, x402Version: (challenge.x402Version as number) || 2 };
}

function buildPaymentPayload(
  challenge: Record<string, unknown>,
  requirement: Record<string, unknown>,
  message: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string },
  signature: string,
  x402Version: number,
): string {
  const paymentPayload = {
    x402Version,
    payload: {
      authorization: {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter: message.validAfter,
        validBefore: message.validBefore,
        nonce: message.nonce,
      },
      signature,
    },
    resource: challenge.resource || null,
    accepted: requirement,
  };
  return btoa(JSON.stringify(paymentPayload));
}

type UcwSdkLike = {
  getDeviceId: () => Promise<string>;
  setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void;
  execute: (challengeId: string, cb: (error: unknown, result: unknown) => void) => void;
  setLocalizations: (l: Record<string, unknown>) => void;
};

// ─── Debug helpers ───────────────────────────────────────────

const ucwDebugEnabled = typeof window !== "undefined" && process.env.NEXT_PUBLIC_PAYLABS_UCW_DEBUG === "1";

function signDbg(msg: string) {
  if (ucwDebugEnabled) {
    console.log("[UCW-sign]", msg);
  }
}

const nowMs = () => Math.round(performance.now());

// ─── UCW Balance Fetcher ─────────────────────────────────────

async function fetchSessionBalance(): Promise<UcwBalance> {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-balance", { method: "POST", credentials: "include" });
  if (!resp.ok) return { walletUsdc: "0", gatewayUsdc: "0", source: "ucw" };
  const data = (await resp.json()) as { usdc: string; gateway: string };
  return { walletUsdc: data.usdc ?? "0", gatewayUsdc: data.gateway ?? "0", source: "ucw" };
}

// ─── UCW Sign with Challenge ─────────────────────────────────

async function signWithUcw(params: {
  challenge: Record<string, unknown>;
  walletAddress: string;
  ucwSdk: UcwSdkLike;
  auth?: { userToken: string; encryptionKey?: string } | null;
}): Promise<string> {
  const { challenge, walletAddress, ucwSdk, auth } = params;
  const signStart = nowMs();
  const { domain, types, message, requirement, x402Version } = buildEip712Params(challenge, walletAddress);

  // Preflight: ensure session exists with wallet data before sign-challenge
  signDbg("preflight: checking session-restore...");
  const t0 = nowMs();
  const checkResp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", { method: "POST", credentials: "include" });
  signDbg(`session-restore: status=${checkResp.status} ${nowMs() - t0}ms`);
  if (checkResp.ok) {
    const sess = (await checkResp.json()) as { hasUserToken: boolean; walletId: string | null; walletAddress: string | null };
    if (!sess.hasUserToken || !sess.walletId || !sess.walletAddress) {
      if (auth) {
        const t1 = nowMs();
        const createResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
        signDbg(`session-create: status=${createResp.status} ${nowMs() - t1}ms`);
        if (!createResp.ok) throw new Error("Session expired. Reconnect wallet.");
        const t2 = nowMs();
        const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userToken: auth.userToken, encryptionKey: auth.encryptionKey }),
        });
        signDbg(`session-save-login: status=${saveResp.status} ${nowMs() - t2}ms`);
        if (!saveResp.ok) throw new Error("Session expired. Reconnect wallet.");
        const repaired = (await saveResp.json()) as { walletAddress?: string | null };
        if (repaired.walletAddress && repaired.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
          throw new Error("Session expired. Reconnect wallet.");
        }
      } else {
        throw new Error("Session expired. Reconnect wallet.");
      }
    }
  } else if (checkResp.status === 401 && auth) {
    const t1 = nowMs();
    const createResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
    signDbg(`session-create(401): status=${createResp.status} ${nowMs() - t1}ms`);
    if (!createResp.ok) throw new Error("Session expired. Reconnect wallet.");
    const t2 = nowMs();
    const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken: auth.userToken, encryptionKey: auth.encryptionKey }),
    });
    signDbg(`session-save-login(401): status=${saveResp.status} ${nowMs() - t2}ms`);
    if (!saveResp.ok) throw new Error("Session expired. Reconnect wallet.");
    const repaired = (await saveResp.json()) as { walletAddress?: string | null };
    if (repaired.walletAddress && repaired.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("Session expired. Reconnect wallet.");
    }
  } else {
    throw new Error("Session expired. Reconnect wallet.");
  }

  // Backend reads walletId/userToken from httpOnly session
  const t3 = nowMs();
  await ucwSdk.getDeviceId();
  signDbg(`getDeviceId: ${nowMs() - t3}ms`);
  if (auth?.encryptionKey) {
    const ek: string = auth.encryptionKey;
    ucwSdk.setAuthentication({ userToken: auth.userToken, encryptionKey: ek });
  }

  const signData = {
    domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...types,
    },
    primaryType: "TransferWithAuthorization",
    message: {
      ...message,
      value: message.value.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
    },
  };

  // sign-challenge reads userToken/walletId from httpOnly session
  signDbg("signChallenge: started");
  const t4 = nowMs();
  const signResp = await fetch("/api/paylabs/wallet/ucw?action=sign-challenge", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: signData }),
  });
  signDbg(`signChallenge: status=${signResp.status} ${nowMs() - t4}ms`);
  if (!signResp.ok) {
    const err = await signResp.json().catch(() => ({}));
    throw new Error(`Sign challenge failed: ${(err as Record<string, string>).error || signResp.status}`);
  }
  const { challengeId } = (await signResp.json()) as { challengeId: string };
  if (!challengeId) throw new Error("No challengeId returned from sign-challenge");

  signDbg("signChallenge: ok, executing challenge via UCW SDK...");
  const t5 = nowMs();
  const amountDisplay = message.value ? (Number(message.value) / 1_000_000).toFixed(6) : "?";
  ucwSdk.setLocalizations({
    signatureRequest: {
      title: "Confirm Payment",
      description: `Pay ${amountDisplay} USDC via x402`,
    },
  });
  const signature: string = await new Promise((resolve, reject) => {
    ucwSdk.execute(challengeId, (error: unknown, result: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else {
        const sig = (result as { signature?: string })?.signature;
        if (sig) resolve(sig);
        else reject(new Error("No signature returned from UCW SDK"));
      }
    });
  });
  signDbg(`ucwSdk.execute: ${nowMs() - t5}ms`);
  signDbg(`signWithUcw total: ${nowMs() - signStart}ms`);

  return buildPaymentPayload(challenge, requirement, message, signature, x402Version);
}

// ─── Sign with EOA (hidden dev fallback) ─────────────────────

async function signWithEoa(params: {
  challenge: Record<string, unknown>;
  walletAddress: string;
}): Promise<string> {
  const { challenge, walletAddress } = params;
  const { domain, types, message, requirement, x402Version } = buildEip712Params(challenge, walletAddress);

  const eth = (window as unknown as Record<string, unknown>).ethereum as
    | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
    | undefined;
  if (!eth) throw new Error("No browser wallet found.");

  const signature = await (eth as { request: (args: { method: string; params: unknown[] }) => Promise<string> }).request({
    method: "eth_signTypedData_v4",
    params: [
      walletAddress,
      JSON.stringify({
        domain,
        types: { EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ], ...types },
        primaryType: "TransferWithAuthorization",
        message,
      }),
    ],
  });

  return buildPaymentPayload(challenge, requirement, message, signature, x402Version);
}

// ─── Post-Login Finalizer ────────────────────────────────────

type SaveLoginData = {
  walletId: string | null;
  walletAddress: string | null;
  challengeId: string | null;
  error?: string;
};

async function finalizeWalletAfterLogin(
  saveData: SaveLoginData,
  sdk: UcwSdkLike,
  cbs: {
    setWalletState: (s: WalletState) => void;
    setWalletError: (e: string | null) => void;
    setUcwWalletId: (id: string | null) => void;
    setWalletInfo: (info: WalletInfo | null) => void;
    setUcwBalance: (b: UcwBalance | null) => void;
  },
  planned: string,
  auth?: { userToken: string; encryptionKey?: string },
): Promise<boolean> {
  if (saveData.error) {
    cbs.setWalletState("not_connected");
    cbs.setWalletError(`Login failed: ${saveData.error}`);
    return false;
  }

  if (saveData.challengeId) {
    try {
      await sdk.getDeviceId();
      if (auth?.encryptionKey) {
        const ek: string = auth.encryptionKey;
        sdk.setAuthentication({ userToken: auth.userToken, encryptionKey: ek });
      }
      sdk.setLocalizations({
        signatureRequest: {
          title: "Create Wallet",
          description: "Set up your secure wallet on Arc Testnet",
        },
      });
      await new Promise<void>((resolve, reject) => {
        sdk.execute(saveData.challengeId!, (err: unknown, result: unknown) => {
          if (err) {
            const msg = err instanceof Error ? err.message : (err as Record<string, string>)?.message || JSON.stringify(err);
            reject(new Error(msg));
          } else {
            resolve();
          }
        });
      });
      const finalizeResp = await fetch("/api/paylabs/wallet/ucw?action=session-finalize-wallet", { method: "POST", credentials: "include" });
      const finalized = (await finalizeResp.json().catch(() => ({}))) as {
        walletId?: string;
        walletAddress?: string;
        error?: string;
      };
      if (!finalizeResp.ok) {
        cbs.setWalletState("not_connected");
        cbs.setWalletError(`Wallet finalize failed: ${finalized.error || finalizeResp.status}`);
        return false;
      }
      saveData.walletId = finalized.walletId ?? null;
      saveData.walletAddress = finalized.walletAddress ?? null;
    } catch (e: unknown) {
      cbs.setWalletState("not_connected");
      cbs.setWalletError(`Wallet challenge failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      return false;
    }
  }

  if (!saveData.walletAddress || !saveData.walletId) {
    cbs.setWalletState("not_connected");
    cbs.setWalletError(
      "Login succeeded, but Circle returned no wallet address. Check session-save-login/list-wallets/session-finalize-wallet logs.",
    );
    return false;
  }

  cbs.setUcwWalletId(saveData.walletId);
  cbs.setWalletInfo({
    address: saveData.walletAddress,
    walletType: "circle_user_controlled",
    network: "Arc Testnet",
  });
  cbs.setWalletState("connected");
  const balance = await fetchSessionBalance();
  cbs.setUcwBalance(balance);
  cbs.setWalletState(parseFloat(balance.gatewayUsdc ?? "0") >= parseFloat(planned) ? "ready_to_approve" : "needs_gateway_deposit");
  return true;
}

// ─── Hook ────────────────────────────────────────────────────

export interface UseCreatorUcwWalletOptions {
  /** Planned cost in USDC (from quote). Used to determine ready_to_approve vs needs_gateway_deposit. */
  plannedCost: string;
}

export interface UseCreatorUcwWalletReturn {
  // State
  walletState: WalletState;
  walletInfo: WalletInfo | null;
  ucwBalance: UcwBalance | null;
  walletError: string | null;
  authMethod: string;
  depositStatus: string | null;
  debugLog: string[];
  ucwDebug: boolean;
  needsReconnectToSign: boolean;
  showEoaFallback: boolean;
  walletCopied: boolean;
  showEmailInputForReconnect: boolean;

  // Handlers (for WalletConnectModal props)
  connectGoogle: () => void;
  connectEmail: (email: string) => void;
  connectPin: () => void;
  connectEoa: () => void;
  depositGateway: (amountAtomic: string) => void;
  reconnectByAuth: () => void;
  copyWalletAddress: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disconnectWallet: () => void;
  onApprove: () => void;

  // For 402 signing on creator page (if needed later)
  signWithUcw: typeof signWithUcw;
  signWithEoa: typeof signWithEoa;
}

export function useCreatorUcwWallet(options: UseCreatorUcwWalletOptions): UseCreatorUcwWalletReturn {
  const { plannedCost } = options;

  // ── State ──
  const [walletState, setWalletState] = useState<WalletState>("not_connected");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [ucwBalance, setUcwBalance] = useState<UcwBalance | null>(null);
  const [ucwWalletId, setUcwWalletId] = useState<string | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);
  const ucwSdkRef = useRef<UcwSdkLike | null>(null);
  const ucwAuthRef = useRef<{ userToken: string; encryptionKey?: string } | null>(null);
  const [authMethod, setAuthMethod] = useState<"google" | "email" | "pin" | "">("");
  const [depositStatus, setDepositStatus] = useState<string | null>(null);
  const [showEmailInputForReconnect, setShowEmailInputForReconnect] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  // Derived
  const ucwCanSign = walletInfo?.walletType === "circle_user_controlled"
    ? !!ucwSdkRef.current && !!ucwAuthRef.current
    : !!walletInfo?.address;

  const needsReconnectToSign =
    walletInfo?.walletType === "circle_user_controlled" &&
    !!walletInfo.address &&
    !ucwCanSign;

  const showEoaFallback = typeof window !== "undefined" && window.location.search.includes("eoa=1");

  const dbg = useCallback((msg: string) => {
    if (!ucwDebugEnabled) return;
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    console.log("[UCW]", entry);
    setDebugLog((prev) => [...prev.slice(-20), entry]);
  }, []);

  // ── Session restore (UCW only) ──
  useEffect(() => {
    let cancelled = false;
    let oauthTimeout: ReturnType<typeof setTimeout> | null = null;

    const restoreUcwSession = async () => {
      dbg("restoreUcwSession: start");

      try {
        const resp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", { method: "POST", credentials: "include" });
        if (!resp.ok) {
          if (resp.status === 401) return;
          setWalletState("not_connected");
          const err = await resp.json().catch(() => ({}));
          setWalletError(`Session restore failed: ${(err as Record<string, string>).error || resp.status}`);
          return;
        }
        const data = (await resp.json()) as { hasDeviceToken: boolean; hasUserToken: boolean; walletId: string | null; walletAddress: string | null; authMethod: string };
        dbg(`session-restore: deviceToken=${data.hasDeviceToken} userToken=${data.hasUserToken} walletId=${data.walletId ? "present" : "null"} walletAddress=${data.walletAddress ? "present" : "null"}`);

        if (data.walletId && data.walletAddress && data.hasUserToken) {
          dbg("Wallet already in session — restoring UI + re-creating SDK");
          setUcwWalletId(data.walletId);
          setWalletInfo({ address: data.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
          setWalletState("connected");
          if (data.authMethod) setAuthMethod(data.authMethod as "google" | "email" | "pin");

          try {
            const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
            const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
            if (appId) {
              const sdk = new W3SSdk({ appSettings: { appId } });
              await sdk.getDeviceId();
              ucwSdkRef.current = sdk as unknown as UcwSdkLike;

              const authResp = await fetch("/api/paylabs/wallet/ucw?action=session-get-auth", {
                method: "POST",
                credentials: "include",
                headers: { "X-Requested-With": "ucw-sdk-restore" },
              });
              if (authResp.ok) {
                const authData = (await authResp.json()) as { userToken: string; encryptionKey: string | null; authMethod: string };
                if (authData.encryptionKey) {
                  ucwAuthRef.current = { userToken: authData.userToken, encryptionKey: authData.encryptionKey };
                  sdk.setAuthentication({ userToken: authData.userToken, encryptionKey: authData.encryptionKey });
                } else {
                  ucwAuthRef.current = { userToken: authData.userToken };
                }
                dbg("SDK re-created and authenticated after refresh");
              }
            }
          } catch (e) {
            dbg(`SDK re-creation failed (will show reconnect): ${e instanceof Error ? e.message : String(e)}`);
          }

          const balance = await fetchSessionBalance();
          setUcwBalance(balance);
          if (parseFloat(balance.gatewayUsdc ?? "0") < parseFloat(plannedCost)) {
            setWalletState("needs_gateway_deposit");
          }
          return;
        }

        if (data.hasUserToken && (!data.walletId || !data.walletAddress)) {
          dbg("User token exists but no wallet — attempting finalize");
          const finResp = await fetch("/api/paylabs/wallet/ucw?action=session-finalize-wallet", { method: "POST", credentials: "include" });
          if (finResp.ok) {
            const fin = (await finResp.json()) as { walletId: string; walletAddress: string; usdc: string; gateway: string };
            setUcwWalletId(fin.walletId);
            setWalletInfo({ address: fin.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
            setUcwBalance({ walletUsdc: fin.usdc ?? "0", gatewayUsdc: fin.gateway ?? "0", source: "ucw" });
            setWalletState("connected");
            if (parseFloat(fin.gateway) < parseFloat(plannedCost)) {
              setWalletState("needs_gateway_deposit");
            }
            return;
          }
          dbg("Finalize failed — destroying session for fresh start");
          fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
          setWalletState("not_connected");
          return;
        }

        if (data.hasDeviceToken && !data.hasUserToken) {
          const hasOAuthHash = window.location.hash.includes("access_token") || window.location.hash.includes("id_token");
          dbg(`OAuth hash check: ${hasOAuthHash ? "present" : "absent"}`);
          if (!hasOAuthHash) {
            dbg("Stale session (deviceToken but no OAuth hash) — destroying");
            fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            setWalletState("not_connected");
            return;
          }
          setWalletState("connecting");
          const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
          const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
          if (!appId) return;

          const dtResp = await fetch("/api/paylabs/wallet/ucw?action=session-get-device", { method: "POST", credentials: "include" });
          if (!dtResp.ok) {
            const err = await dtResp.json().catch(() => ({}));
            setWalletState("not_connected");
            setWalletError(`Session restore failed: ${(err as Record<string, string>).error || dtResp.status}`);
            return;
          }
          const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

          const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
          dbg(`Restoring SDK deviceToken=${deviceToken ? "present" : "absent"} googleClientId=${googleClientId ? "present" : "absent"} oauthHash=${window.location.hash ? "present" : "absent"}`);

          let callbackFired = false;
          const fullConfig = {
            appSettings: { appId },
            loginConfigs: {
              deviceToken,
              deviceEncryptionKey,
              ...(googleClientId
                ? {
                    google: {
                      clientId: googleClientId,
                      redirectUri: window.location.origin,
                      selectAccountPrompt: true,
                    },
                  }
                : {}),
            },
          };
          const sdk = new W3SSdk(fullConfig, async (error: unknown, result: unknown) => {
              callbackFired = true;
              dbg(`Login callback: ${error ? "ERROR: " + (error instanceof Error ? error.message : String(error)) : "SUCCESS"}`);
              if (error) {
                setWalletState("not_connected");
                setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
                return;
              }
              const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
              ucwAuthRef.current = { userToken, encryptionKey };
              if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
              setAuthMethod("google");
              dbg("Login token obtained, saving to session...");
              const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userToken, encryptionKey, authMethod: "google" }),
              });
              if (!saveResp.ok) {
                setWalletState("not_connected");
                setWalletError("Failed to save login session");
                return;
              }
              const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };
              dbg(`session-save-login: wid=${saveData.walletId} addr=${saveData.walletAddress} challenge=${saveData.challengeId} err=${saveData.error}`);

              const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
              await finalizeWalletAfterLogin(saveData, sdk as unknown as UcwSdkLike, cbs, plannedCost, { userToken, encryptionKey });
            });
          ucwSdkRef.current = sdk as unknown as UcwSdkLike;

          oauthTimeout = setTimeout(() => {
            if (!callbackFired && !cancelled) {
              console.warn("[UCW] Login callback did not fire after 10s — OAuth detection likely failed");
              setWalletState("not_connected");
              setWalletError("Login timed out. Please try again.");
              fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            }
          }, 10000);
        }
      } catch (e: unknown) {
        setWalletState("not_connected");
        setWalletError(`Restore failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      }
    };
    restoreUcwSession();

    return () => {
      cancelled = true;
      if (oauthTimeout) clearTimeout(oauthTimeout);
    };
  }, [plannedCost]);

  // ── Connect via Google (UCW social login) ──
  const connectGoogle = useCallback(async () => {
    if (walletState === "connecting") return;
    dbg("connectGoogle: start");
    setWalletState("connecting");
    setWalletError(null);

    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      const sessionResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
      if (!sessionResp.ok) {
        const err = await sessionResp.json().catch(() => ({}));
        dbg("session-create: FAIL " + sessionResp.status);
        throw new Error(`Session create failed: ${(err as Record<string, string>).error || sessionResp.status}`);
      }

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk as unknown as UcwSdkLike;

      const dtResp = await fetch("/api/paylabs/wallet/ucw?action=device-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!dtResp.ok) {
        const err = await dtResp.json().catch(() => ({}));
        dbg("device-token: FAIL " + dtResp.status);
        throw new Error(`Device token failed: ${(err as Record<string, string>).error || dtResp.status}`);
      }
      const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

      const saveDeviceResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
      });
      if (!saveDeviceResp.ok) {
        const err = await saveDeviceResp.json().catch(() => ({}));
        dbg("session-save-device: FAIL " + saveDeviceResp.status);
        throw new Error(`Session save device failed: ${(err as Record<string, string>).error || saveDeviceResp.status}`);
      }

      sdk.updateConfigs(
        {
          appSettings: { appId },
          loginConfigs: {
            deviceToken,
            deviceEncryptionKey,
            google: {
              clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
              redirectUri: window.location.origin,
              selectAccountPrompt: true,
            },
          },
        },
        async (error: unknown, result: unknown) => {
          if (error) {
            setWalletState("not_connected");
            setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
            return;
          }
          const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
          ucwAuthRef.current = { userToken, encryptionKey };
          setAuthMethod("google");
          const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userToken, encryptionKey, authMethod: "google" }),
          });
          if (!saveResp.ok) {
            setWalletState("not_connected");
            setWalletError("Failed to save login");
            return;
          }
          const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };

          const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
          await finalizeWalletAfterLogin(saveData, sdk as unknown as UcwSdkLike, cbs, plannedCost, { userToken, encryptionKey });
        },
      );

      const { SocialLoginProvider } = await import("@circle-fin/w3s-pw-web-sdk/dist/src/types");
      dbg("Calling performLogin(GOOGLE)...");
      sdk.performLogin(SocialLoginProvider.GOOGLE);
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, [plannedCost, walletState]);

  // ── Connect EOA wallet (hidden fallback) ──
  const connectEoa = useCallback(async () => {
    setWalletState("connecting");
    setWalletError(null);
    try {
      const eth = (window as unknown as Record<string, unknown>).ethereum as
        | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
        | undefined;
      if (!eth) {
        setWalletState("not_connected");
        setWalletError("No browser wallet found. Install MetaMask or similar.");
        return;
      }
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts || accounts.length === 0) {
        setWalletState("not_connected");
        setWalletError("Wallet connection rejected.");
        return;
      }
      setWalletInfo({ address: accounts[0], walletType: "external_eoa", network: "Arc Testnet" });
      setWalletState("ready_to_approve");
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, []);

  // ── Connect via Email OTP ──
  const connectEmail = useCallback(async (email: string) => {
    if (walletState === "connecting") return;
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk as unknown as UcwSdkLike;

      const dtResp = await fetch("/api/paylabs/wallet/ucw?action=email-device-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, email }),
      });
      if (!dtResp.ok) {
        const err = await dtResp.json().catch(() => ({}));
        throw new Error(`Email device token failed: ${(err as Record<string, string>).error || dtResp.status}`);
      }
      const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

      await fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
      });

      sdk.updateConfigs(
        { appSettings: { appId }, loginConfigs: { deviceToken, deviceEncryptionKey } },
        async (error: unknown, result: unknown) => {
          if (error) {
            setWalletState("not_connected");
            setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
            return;
          }
          const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
          ucwAuthRef.current = encryptionKey ? { userToken, encryptionKey } : { userToken };
          setAuthMethod("email");
          const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userToken, encryptionKey, authMethod: "email" }),
          });
          const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };
          const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
          await finalizeWalletAfterLogin(saveData, sdk as unknown as UcwSdkLike, cbs, plannedCost, { userToken, encryptionKey });
        },
      );

      sdk.verifyOtp();
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Email login failed.");
    }
  }, [plannedCost, walletState]);

  // ── Connect via PIN ──
  const connectPin = useCallback(async () => {
    if (walletState === "connecting") return;
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk as unknown as UcwSdkLike;

      const userId = deviceId;
      const createResp = await fetch("/api/paylabs/wallet/ucw?action=create-user", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({}));
        if ((err as Record<string, number>).code !== 155106) {
          throw new Error(`Create user failed: ${(err as Record<string, string>).error || createResp.status}`);
        }
      }

      const utResp = await fetch("/api/paylabs/wallet/ucw?action=user-token", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!utResp.ok) {
        const err = await utResp.json().catch(() => ({}));
        throw new Error(`User token failed: ${(err as Record<string, string>).error || utResp.status}`);
      }
      const { userToken, encryptionKey } = (await utResp.json()) as { userToken: string; encryptionKey: string };
      ucwAuthRef.current = encryptionKey ? { userToken, encryptionKey } : { userToken };

      if (encryptionKey) {
        sdk.setAuthentication({ userToken, encryptionKey });
      }

      setAuthMethod("pin");
      const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, encryptionKey, authMethod: "pin" }),
      });
      if (!saveResp.ok) throw new Error("Failed to save login session");
      const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };

      const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
      await finalizeWalletAfterLogin(saveData, sdk as unknown as UcwSdkLike, cbs, plannedCost, encryptionKey ? { userToken, encryptionKey } : undefined);
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "PIN login failed.");
    }
  }, [plannedCost, walletState]);

  // ── Gateway deposit ──
  const depositGateway = useCallback(async (amountAtomic: string) => {
    setWalletState("approving");
    setWalletError(null);
    setDepositStatus(null);
    try {
      const resp = await fetch("/api/paylabs/wallet/ucw?action=deposit", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountAtomic }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const errMsg = (err as Record<string, string>).error || String(resp.status);
        if (resp.status === 401) {
          setWalletState("not_connected");
          throw new Error("Session expired — please reconnect your wallet");
        }
        throw new Error(`Deposit challenge failed: ${errMsg}`);
      }
      const data = (await resp.json()) as {
        step: "approve_required" | "deposit_ready";
        approveChallengeId?: string;
        depositChallengeId?: string;
      };

      if (data.step === "deposit_ready" && !data.depositChallengeId) {
        throw new Error("Deposit challenge missing. Please try again.");
      }

      const sdk = ucwSdkRef.current;
      if (!sdk) throw new Error("UCW SDK not initialized");

      const execErr = (err: unknown) => {
        const msg = err instanceof Error ? err.message : (err as Record<string, string>)?.message || JSON.stringify(err);
        return new Error(msg);
      };

      const prepareSdk = async () => {
        await sdk.getDeviceId();
        const auth = ucwAuthRef.current;
        if (auth?.encryptionKey) {
          const ek: string = auth.encryptionKey;
          sdk.setAuthentication({ userToken: auth.userToken, encryptionKey: ek });
        }
      };

      if (data.step === "approve_required" && data.approveChallengeId) {
        setDepositStatus("Step 1/2: Approving USDC spend…");
        await prepareSdk();
        sdk.setLocalizations({
          contractInteraction: {
            title: "Approve USDC",
            subtitle: "Allow Gateway to spend your USDC for deposits",
          },
        });
        await new Promise<void>((resolve, reject) => {
          sdk.execute(data.approveChallengeId!, (err: unknown) => err ? reject(execErr(err)) : resolve());
        });

        setDepositStatus("Approving USDC allowance…");
        let allowanceConfirmed = false;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const checkResp = await fetch("/api/paylabs/wallet/ucw?action=check-allowance", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amountAtomic }),
          });
          if (checkResp.ok) {
            const check = (await checkResp.json()) as { sufficient: boolean };
            if (check.sufficient) {
              allowanceConfirmed = true;
              break;
            }
          }
        }
        if (!allowanceConfirmed) {
          setDepositStatus("Approval submitted. Allowance is not confirmed yet. Please try deposit again shortly.");
          setWalletState(parseFloat((await fetchSessionBalance()).gatewayUsdc ?? "0") >= parseFloat(plannedCost) ? "ready_to_approve" : "needs_gateway_deposit");
          return;
        }

        setDepositStatus("Allowance confirmed. Creating deposit…");
        const depositResp = await fetch("/api/paylabs/wallet/ucw?action=deposit", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amountAtomic }),
        });
        if (!depositResp.ok) {
          const err = await depositResp.json().catch(() => ({}));
          throw new Error(`Deposit challenge failed: ${(err as Record<string, string>).error || depositResp.status}`);
        }
        const depositData = (await depositResp.json()) as { step: string; depositChallengeId?: string };
        if (!depositData.depositChallengeId) throw new Error("No deposit challenge returned after allowance confirmed");
        data.depositChallengeId = depositData.depositChallengeId;
      }

      if (data.depositChallengeId) {
        setDepositStatus("Step 2/2: Depositing to Gateway…");
        await prepareSdk();
        sdk.setLocalizations({
          contractInteraction: {
            title: "Deposit to Gateway",
            subtitle: `Deposit ${Number(amountAtomic) / 1_000_000} USDC to Gateway`,
          },
        });
        await new Promise<void>((resolve, reject) => {
          sdk.execute(data.depositChallengeId!, (err: unknown) => err ? reject(execErr(err)) : resolve());
        });
      }

      setDepositStatus("Waiting for Gateway balance confirmation…");
      const startBal = parseFloat((await fetchSessionBalance()).gatewayUsdc ?? "0");
      const requiredBal = parseFloat(amountAtomic) / 1_000_000;
      let confirmed = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const balance = await fetchSessionBalance();
        setUcwBalance(balance);
        const gwBal = parseFloat(balance.gatewayUsdc ?? "0");
        if (gwBal > startBal || gwBal >= requiredBal) {
          confirmed = true;
          setDepositStatus(null);
          setWalletState(gwBal >= parseFloat(plannedCost) ? "ready_to_approve" : "needs_gateway_deposit");
          if (gwBal >= parseFloat(plannedCost)) setWalletError(null);
          break;
        }
      }
      if (!confirmed) {
        setDepositStatus("Deposit submitted. Gateway balance has not updated yet. Please refresh balance shortly.");
        const finalBalance = await fetchSessionBalance();
        setUcwBalance(finalBalance);
        setWalletState(parseFloat(finalBalance.gatewayUsdc ?? "0") >= parseFloat(plannedCost) ? "ready_to_approve" : "needs_gateway_deposit");
      }
    } catch (e: unknown) {
      setWalletState("needs_gateway_deposit");
      setWalletError(e instanceof Error ? e.message : "Deposit failed.");
      setDepositStatus(null);
    }
  }, [plannedCost]);

  // ── Reconnect by auth method ──
  const reconnectByAuth = useCallback(() => {
    if (authMethod === "google") connectGoogle();
    else if (authMethod === "email") {
      setShowEmailInputForReconnect(true);
    }
    else if (authMethod === "pin") connectPin();
  }, [authMethod, connectGoogle, connectPin]);

  // ── Copy wallet address ──
  const copyWalletAddress = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!walletInfo?.address) return;
    try {
      await navigator.clipboard?.writeText(walletInfo.address);
      setWalletCopied(true);
      window.setTimeout(() => setWalletCopied(false), 1200);
    } catch {
      setWalletError("Could not copy wallet address.");
    }
  }, [walletInfo?.address]);

  // ── Disconnect wallet ──
  const disconnectWallet = useCallback(() => {
    fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
    setUcwWalletId(null);
    setWalletInfo(null);
    setWalletState("not_connected");
    setUcwBalance(null);
    setWalletError(null);
    ucwSdkRef.current = null;
    ucwAuthRef.current = null;
  }, []);

  // ── Approve (no-op for UCW on creator page — used by WalletConnectModal) ──
  const onApprove = useCallback(() => {
    // On creator page, approve doesn't submit a chat. It's a no-op.
    // The chat page handles approve → submitChat.
  }, []);

  return {
    walletState,
    walletInfo,
    ucwBalance,
    walletError,
    authMethod,
    depositStatus,
    debugLog,
    ucwDebug: ucwDebugEnabled,
    needsReconnectToSign,
    showEoaFallback,
    walletCopied,
    showEmailInputForReconnect,
    connectGoogle,
    connectEmail,
    connectPin,
    connectEoa,
    depositGateway,
    reconnectByAuth,
    copyWalletAddress,
    disconnectWallet,
    onApprove,
    signWithUcw,
    signWithEoa,
  };
}
