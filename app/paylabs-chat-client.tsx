"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import SidebarPanel from "@/components/paylabs/SidebarPanel";
import WalletConnectModal from "@/components/paylabs/WalletConnectModal";
import type { WalletState, WalletInfo, UcwBalance } from "@/components/paylabs/WalletConnectModal";

// ─── Types ──────────────────────────────────────────────────

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
  topWallet?: { address: string; runs: number } | null;
};

type Props = {
  analytics: Analytics;
};

type SafeRunResult = {
  ok: boolean;
  runId: string | null;
  status: string | null;
  tier: string | null;
  entryPaymentStatus: string | null;
  plannedCostUsdc: number | null;
  paidEdges: number;
  totalEdges: number;
  receiptReady: boolean;
  safeSummary: string;
  reasoning: string | null;
};

// UCW sensitive tokens are stored server-side in httpOnly session cookie.
// Frontend only holds wallet address + wallet ID (non-sensitive) in memory.

// ─── Helpers ────────────────────────────────────────────────

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

// TODO(#27): plannedCost should come from backend quote/402 response, not frontend constants.
// TIER_COSTS is a fallback estimate for run gating only. After Brain auto-selects tier,
// the inline route should return { plannedCostUsdc, routeTier } which the frontend uses.
const TIER_COSTS: Record<string, string> = {
  easy: "0.000007",
  normal: "0.000013",
  advanced: "0.000015",
};

// UCW session is memory-only — no cookies, no localStorage.
// Sensitive tokens (userToken, encryptionKey, deviceToken) never persist
// across page reloads. User must re-authenticate on each session.

function toSafeRunResult(data: Record<string, unknown>): SafeRunResult {
  const paymentGraph =
    (data?.payment_graph as unknown[]) ??
    (data?.result as Record<string, unknown>)?.paymentGraph as unknown[] ??
    (data?.agent_trace as Record<string, unknown>)?.payment_graph as unknown[] ??
    (data?.exit_output as Record<string, unknown>)?.payment_graph as unknown[] ??
    [];

  const paidEdges = Array.isArray(paymentGraph)
    ? paymentGraph.filter((e: unknown) => (e as Record<string, string>).status === "paid").length
    : 0;

  const exitOutput = data?.exit_output as Record<string, unknown> | undefined;
  const quote = data?.quote as Record<string, unknown> | undefined;

  return {
    ok: !!data?.ok,
    runId: (data?.discovery_run_id as string) ?? (data?.id as string) ?? null,
    status: (data?.status as string) ?? null,
    tier: (data?.route_tier as string) ?? null,
    entryPaymentStatus: (data?.entry_payment as Record<string, string>)?.status ?? null,
    plannedCostUsdc: (quote?.plannedCostUsdc as number) ?? (exitOutput?.planned_cost_usdc as number) ?? null,
    paidEdges,
    totalEdges: Array.isArray(paymentGraph) ? paymentGraph.length : 0,
    receiptReady: (data?.receipt_ready as boolean) ?? (exitOutput?.receipt_ready as boolean) ?? false,
    safeSummary:
      (exitOutput?.final_summary as string) ??
      (data?.tiered_summaries as Record<string, string>)?.final_summary ??
      "Run completed.",
    reasoning:
      (data?.reasoning as string) ??
      ((data?.agent_trace as Record<string, unknown>)?.brain_planning as Record<string, string>)?.reasoning ??
      null,
  };
}

// ─── x402 Client Signing ────────────────────────────────────

const ARC_CHAIN_ID = 5042002;
const GATEWAY_VERIFIED_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

function randomNonce(): `0x${string}` {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return `0x${Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/** Build EIP-712 params for x402 TransferWithAuthorization */
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

/** Build x402 payment payload from EIP-712 signature */
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

/** Sign with external EOA (window.ethereum) — hidden dev fallback */
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
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...types,
        },
        domain,
        primaryType: "TransferWithAuthorization",
        message: {
          ...message,
          value: BigInt(message.value),
          validAfter: BigInt(message.validAfter),
          validBefore: BigInt(message.validBefore),
        },
      }),
    ],
  });

  return buildPaymentPayload(challenge, requirement, message, signature, x402Version);
}

/** Safe debug log — gated behind NEXT_PUBLIC_PAYLABS_UCW_DEBUG=1 */
function signDbg(msg: string) {
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_PAYLABS_UCW_DEBUG === "1") {
    console.log("[UCW-sign]", msg);
  }
}

/** Sign with Circle UCW via challenge-response */
async function signWithUcw(params: {
  challenge: Record<string, unknown>;
  walletAddress: string;
  ucwSdk: { getDeviceId: () => Promise<string>; setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void; execute: (challengeId: string, cb: (error: unknown, result: unknown) => void) => void };
  auth?: { userToken: string; encryptionKey?: string } | null;
}): Promise<string> {
  const { challenge, walletAddress, ucwSdk, auth } = params;
  const { domain, types, message, requirement, x402Version } = buildEip712Params(challenge, walletAddress);

  // Preflight: ensure session exists with wallet data before sign-challenge
  signDbg("preflight: checking session-restore...");
  const checkResp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", { method: "POST", credentials: "include" });
  signDbg(`session-restore: status=${checkResp.status}`);
  if (checkResp.ok) {
    const sess = (await checkResp.json()) as { hasUserToken: boolean; walletId: string | null; walletAddress: string | null };
    if (!sess.hasUserToken || !sess.walletId || !sess.walletAddress) {
      // Session exists but incomplete — try repair
      if (auth) {
        const createResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
        if (!createResp.ok) throw new Error("Session expired. Reconnect wallet.");
        const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userToken: auth.userToken, encryptionKey: auth.encryptionKey }),
        });
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
    // Session expired — recreate and re-save auth
    const createResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
    if (!createResp.ok) throw new Error("Session expired. Reconnect wallet.");
    const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken: auth.userToken, encryptionKey: auth.encryptionKey }),
    });
    if (!saveResp.ok) throw new Error("Session expired. Reconnect wallet.");
    const repaired = (await saveResp.json()) as { walletAddress?: string | null };
    if (repaired.walletAddress && repaired.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error("Session expired. Reconnect wallet.");
    }
  } else {
    throw new Error("Session expired. Reconnect wallet.");
  }

  // Backend reads walletId/userToken from httpOnly session
  await ucwSdk.getDeviceId();
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
  const signResp = await fetch("/api/paylabs/wallet/ucw?action=sign-challenge", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: signData }),
  });
  signDbg(`signChallenge: status=${signResp.status}`);
  if (!signResp.ok) {
    const err = await signResp.json().catch(() => ({}));
    throw new Error(`Sign challenge failed: ${(err as Record<string, string>).error || signResp.status}`);
  }
  const { challengeId } = (await signResp.json()) as { challengeId: string };
  if (!challengeId) throw new Error("No challengeId returned from sign-challenge");
  signDbg("signChallenge: ok, executing challenge via UCW SDK...");

  // Step 2: Execute challenge via UCW SDK (user approves via Circle hosted UI)
  const signature: string = await new Promise((resolve, reject) => {
    ucwSdk.execute(challengeId, (error: unknown, result: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else {
        // Circle SDK returns signature at result.data.signature for SIGN_TYPEDDATA
        const sig = (result as { data?: { signature?: string } })?.data?.signature;
        if (!sig) reject(new Error("No signature returned from UCW challenge"));
        else resolve(sig);
      }
    });
  });

  return buildPaymentPayload(challenge, requirement, message, signature, x402Version);
}

// ─── UCW Post-Login Finalizer ───────────────────────────────

type SaveLoginData = {
  walletId: string | null;
  walletAddress: string | null;
  challengeId: string | null;
  error?: string;
};

type FinalizeCallbacks = {
  setWalletState: (s: WalletState) => void;
  setWalletError: (e: string | null) => void;
  setUcwWalletId: (id: string | null) => void;
  setWalletInfo: (info: WalletInfo | null) => void;
  setUcwBalance: (b: UcwBalance | null) => void;
};

/** Shared post-login flow: execute challenge → finalize → validate → update UI.
 *  Returns true if wallet is ready, false if any step fails (error already set).
 */
async function finalizeWalletAfterLogin(
  saveData: SaveLoginData,
  sdk: { getDeviceId: () => Promise<string>; setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void; execute: (challengeId: string, cb: (error: unknown, result: unknown) => void) => void },
  cbs: FinalizeCallbacks,
  planned: string,
  auth?: { userToken: string; encryptionKey?: string },
): Promise<boolean> {
  if (saveData.error) {
    cbs.setWalletState("not_connected");
    cbs.setWalletError(`Login failed: ${saveData.error}`);
    return false;
  }

  // Execute wallet creation challenge if needed
  if (saveData.challengeId) {
    try {
      // Per Circle docs: getDeviceId() must be called before execute()
      // to establish the iframe session with Circle's service.
      await sdk.getDeviceId();
      // Per Circle docs: setAuthentication() must be called before execute()
      // to authenticate the challenge with userToken + encryptionKey.
      if (auth?.encryptionKey) {
        const ek: string = auth.encryptionKey;
        sdk.setAuthentication({ userToken: auth.userToken, encryptionKey: ek });
      }
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

  // Fail closed: must have wallet address
  if (!saveData.walletAddress || !saveData.walletId) {
    cbs.setWalletState("not_connected");
    cbs.setWalletError(
      "Login succeeded, but Circle returned no wallet address. Check session-save-login/list-wallets/session-finalize-wallet logs.",
    );
    return false;
  }

  // Success — update UI
  cbs.setUcwWalletId(saveData.walletId);
  cbs.setWalletInfo({
    address: saveData.walletAddress,
    walletType: "circle_user_controlled",
    network: "Arc Testnet",
  });
  cbs.setWalletState("connected");
  const balance = await fetchSessionBalance();
  cbs.setUcwBalance(balance);
  cbs.setWalletState(parseFloat(balance.gateway) >= parseFloat(planned) ? "ready_to_approve" : "needs_gateway_deposit");
  return true;
}

// ─── UCW Balance Fetcher ────────────────────────────────────

/** Fetch balance via server-side session (tokens stay server-side) */
async function fetchSessionBalance(): Promise<UcwBalance> {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-balance", { method: "POST", credentials: "include" });
  if (!resp.ok) return { usdc: "0", gateway: "0" };
  const data = (await resp.json()) as { usdc: string; gateway: string };
  return { usdc: data.usdc ?? "0", gateway: data.gateway ?? "0" };
}

// ─── Main Component ─────────────────────────────────────────

export default function PayLabsChatClient({ analytics }: Props) {
  // Chat state
  const [prompt, setPrompt] = useState("");

  const [budget, setBudget] = useState("0.02");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SafeRunResult | null>(null);

  // Wallet state
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletState, setWalletState] = useState<WalletState>("not_connected");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [ucwBalance, setUcwBalance] = useState<UcwBalance | null>(null);

  // UCW state — wallet info in memory, tokens server-side
  const [ucwWalletId, setUcwWalletId] = useState<string | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);
  const ucwSdkRef = useRef<unknown>(null); // W3SSdk instance
  const ucwAuthRef = useRef<{ userToken: string; encryptionKey?: string } | null>(null);

  // Derived: can this wallet actually sign right now?
  const ucwCanSign = walletInfo?.walletType === "circle_user_controlled"
    ? !!ucwSdkRef.current && !!ucwAuthRef.current
    : !!walletInfo?.address;

  const needsReconnectToSign =
    walletInfo?.walletType === "circle_user_controlled" &&
    !!walletInfo.address &&
    !ucwCanSign;

  // Debug log — gated behind env var, stripped from production
  const ucwDebug = process.env.NEXT_PUBLIC_PAYLABS_UCW_DEBUG === "1";
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const dbg = useCallback((msg: string) => {
    if (!ucwDebug) return;
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] ${msg}`;
    console.log("[UCW]", entry);
    setDebugLog((prev) => [...prev.slice(-20), entry]);
  }, [ucwDebug]);

  // TODO(#27): Replace with backend quote once inline route returns plannedCostUsdc.
// For now, this is a frontend estimate used only for run gating (balance < cost → block).
const planned = useMemo(() => TIER_COSTS["easy"] || "0.000007", []);

  // ── Post-redirect: restore SDK from server session ──
  useEffect(() => {
    const restoreAfterRedirect = async () => {
      dbg("restoreAfterRedirect: start");
      try {
        const resp = await fetch("/api/paylabs/wallet/ucw?action=session-restore", { method: "POST", credentials: "include" });
        if (!resp.ok) {
          // 401 = no session cookie or expired → normal first-visit state, not an error
          if (resp.status === 401) return;
          setWalletState("not_connected");
          const err = await resp.json().catch(() => ({}));
          setWalletError(`Session restore failed: ${(err as Record<string, string>).error || resp.status}`);
          return;
        }
        const data = (await resp.json()) as { hasDeviceToken: boolean; hasUserToken: boolean; walletId: string | null; walletAddress: string | null };
        dbg(`session-restore: deviceToken=${data.hasDeviceToken} userToken=${data.hasUserToken} walletId=${data.walletId ? "present" : "null"} walletAddress=${data.walletAddress ? "present" : "null"}`);

        // If we already have a wallet from a previous session, just restore UI
        if (data.walletId && data.walletAddress && data.hasUserToken) {
          dbg("Wallet already in session — restoring UI (SDK/auth may be missing)");
          setUcwWalletId(data.walletId);
          setWalletInfo({ address: data.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
          setWalletState("connected");
          const balance = await fetchSessionBalance();
          setUcwBalance(balance);
          // After refresh, ucwSdkRef/ucwAuthRef are null — don't set ready_to_approve.
          // Let needsReconnectToSign drive the UI. User must reconnect to sign.
          if (parseFloat(balance.gateway) < parseFloat(planned)) {
            setWalletState("needs_gateway_deposit");
          }
          return;
        }

        // If userToken exists but wallet was never finalized → re-run finalize
        if (data.hasUserToken && (!data.walletId || !data.walletAddress)) {
          dbg("User token exists but no wallet — attempting finalize");
          // Call session-finalize-wallet to check if wallet exists now
          const finResp = await fetch("/api/paylabs/wallet/ucw?action=session-finalize-wallet", { method: "POST", credentials: "include" });
          if (finResp.ok) {
            const fin = (await finResp.json()) as { walletId: string; walletAddress: string; usdc: string; gateway: string };
            setUcwWalletId(fin.walletId);
            setWalletInfo({ address: fin.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
            setUcwBalance({ usdc: fin.usdc ?? "0", gateway: fin.gateway ?? "0" });
            setWalletState("connected");
            if (parseFloat(fin.gateway) < parseFloat(planned)) {
              setWalletState("needs_gateway_deposit");
            }
            return;
          }
          // If finalize fails (no wallets yet), destroy stale session and start fresh
          dbg("Finalize failed — destroying session for fresh start");
          fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
          setWalletState("not_connected");
          return;
        }

        // If we have device token but no user token → SDK needs to finalize OAuth
        // ONLY if we actually have an OAuth hash in the URL (post-redirect).
        // If no hash, this is a stale session — destroy it and start fresh.
        if (data.hasDeviceToken && !data.hasUserToken) {
          const hasOAuthHash = window.location.hash.includes("access_token") || window.location.hash.includes("id_token");
          dbg(`OAuth hash check: ${hasOAuthHash ? "present" : "absent"}`);
          if (!hasOAuthHash) {
            // Stale session — device token saved but OAuth never completed
            dbg("Stale session (deviceToken but no OAuth hash) — destroying");
            fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            setWalletState("not_connected");
            return;
          }
          setWalletState("connecting");
          const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
          const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
          if (!appId) return;

          // Get device token from server session
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
          // Per Circle docs: pass loginConfigs + callback in CONSTRUCTOR.
          // setupInstance() → execSocialLoginStatusCheck() runs inside constructor
          // and needs loginConfigs (deviceToken) to verify the OAuth token via iframe.
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
              // Clear OAuth hash from URL to avoid re-processing on next visit
              if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
              dbg("Login token obtained, saving to session...");
              // Save to server session + finalize (init user, list wallets)
              const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userToken, encryptionKey }),
              });
              if (!saveResp.ok) {
                setWalletState("not_connected");
                setWalletError("Failed to save login session");
                return;
              }
              const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };
              dbg(`session-save-login: wid=${saveData.walletId} addr=${saveData.walletAddress} challenge=${saveData.challengeId} err=${saveData.error}`);

              const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
              await finalizeWalletAfterLogin(saveData, sdk, cbs, planned, { userToken, encryptionKey });
            });
          ucwSdkRef.current = sdk;
          // NOTE: do NOT call sdk.getDeviceId() here!
          // The constructor's setupInstance() already calls execSocialLoginStatusCheck()
          // which calls verifyTokenViaService() and appends the OAuth iframe.
          // Calling getDeviceId() would MOVE the same iframe element to a different
          // route, killing the OAuth verification. It also unsubscribes the message
          // handler on timeout, preventing the onLoginComplete callback from ever firing.

          // Timeout: if callback didn't fire in 10s, the OAuth detection failed
          setTimeout(() => {
            if (!callbackFired) {
              console.warn("[UCW] Login callback did not fire after 10s — OAuth detection likely failed");
              setWalletState("not_connected");
              setWalletError("Login timed out. Please try again.");
              // Clear stale session so next attempt starts fresh
              fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            }
          }, 10000);
        }
      } catch (e: unknown) {
        setWalletState("not_connected");
        setWalletError(`Restore failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      }
    };
    restoreAfterRedirect();
  }, [planned]);

  // ── Session lifecycle: cookie TTL refreshed by session-restore + session-balance ──
  // No auto-destroy needed — session has 30 min TTL, refreshed on every API call.

  // ── Connect via Google (UCW social login) ──
  const connectGoogle = useCallback(async () => {
    // Guard: prevent re-entry if already connecting
    if (walletState === "connecting") return;
    dbg("connectGoogle: start");
    setWalletState("connecting");
    setWalletError(null);

    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      // Create server-side session (sets httpOnly cookie)
      const sessionResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
      if (!sessionResp.ok) {
        const err = await sessionResp.json().catch(() => ({}));
        dbg("session-create: FAIL " + sessionResp.status);
        throw new Error(`Session create failed: ${(err as Record<string, string>).error || sessionResp.status}`);
      }

      // Init SDK + get deviceId
      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk;

      // Create device token via backend
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

      // Save device token to server session
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

      // Re-init SDK with device token + Google config + login callback
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
          // This callback fires after OAuth redirect
          if (error) {
            setWalletState("not_connected");
            setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
            return;
          }
          const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
          ucwAuthRef.current = { userToken, encryptionKey };
          // Save login to server session + finalize
          const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userToken, encryptionKey }),
          });
          if (!saveResp.ok) {
            setWalletState("not_connected");
            setWalletError("Failed to save login");
            return;
          }
          const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };

          const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
          await finalizeWalletAfterLogin(saveData, sdk, cbs, planned, { userToken, encryptionKey });
        },
      );

      // Trigger Google OAuth redirect
      const { SocialLoginProvider } = await import("@circle-fin/w3s-pw-web-sdk/dist/src/types");
      dbg("Calling performLogin(GOOGLE)...");
      sdk.performLogin(SocialLoginProvider.GOOGLE);
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, [planned, walletState]);

// finalizeUcwLogin removed — server-side session handles finalization.

// OAuth redirect detection removed — session is memory-only.
  // After OAuth redirect, user must click "Continue with Google" again.

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

      // Create server session
      await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk;

      // Create email device token
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

      // Save device token to server session
      await fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
      });

      // Update SDK with email device token + login callback
      sdk.updateConfigs(
        { appSettings: { appId }, loginConfigs: { deviceToken, deviceEncryptionKey } },
        async (error: unknown, result: unknown) => {
          if (error) {
            setWalletState("not_connected");
            setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
            return;
          }
          const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
          const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userToken, encryptionKey }),
          });
          const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };
          const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
          await finalizeWalletAfterLogin(saveData, sdk, cbs, planned, { userToken, encryptionKey });
        },
      );

      sdk.verifyOtp();
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Email login failed.");
    }
  }, [planned, walletState]);

  // ── Connect via PIN ──
  const connectPin = useCallback(async () => {
    if (walletState === "connecting") return;
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      // Create server session
      await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk;

      // Step 1: Create user in Circle (required before getUserToken)
      const userId = deviceId; // use deviceId as userId for PIN auth
      const createResp = await fetch("/api/paylabs/wallet/ucw?action=create-user", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({}));
        // 155106 = user already exists, continue
        if ((err as Record<string, number>).code !== 155106) {
          throw new Error(`Create user failed: ${(err as Record<string, string>).error || createResp.status}`);
        }
      }

      // Step 2: Get user token (60-min session)
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
      // Store auth for later use by signWithUcw (encryptionKey may be absent for PIN auth)
      ucwAuthRef.current = encryptionKey ? { userToken, encryptionKey } : { userToken };

      // Step 3: Set auth BEFORE execute
      // For PIN auth, encryptionKey may not be available (createUserToken doesn't return it).
      // Only call setAuthentication when encryptionKey is present.
      if (encryptionKey) {
        sdk.setAuthentication({ userToken, encryptionKey });
      }

      // Save login to server session + finalize (init user + list wallets)
      const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, encryptionKey }),
      });
      if (!saveResp.ok) throw new Error("Failed to save login session");
      const saveData = (await saveResp.json()) as { walletId: string | null; walletAddress: string | null; challengeId: string | null; error?: string };

      const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
      await finalizeWalletAfterLogin(saveData, sdk, cbs, planned, encryptionKey ? { userToken, encryptionKey } : undefined);
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "PIN login failed.");
    }
  }, [planned, walletState]);

  // ── Gateway deposit (UCW contract execution) ──
  const depositGateway = useCallback(async (amountAtomic: string) => {
    setWalletState("approving");
    setWalletError(null);
    try {

      const resp = await fetch("/api/paylabs/wallet/ucw?action=approve-deposit", {
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
      const { approve, deposit } = (await resp.json()) as {
        approve: { challengeId: string };
        deposit: { challengeId: string };
      };

      const sdk = ucwSdkRef.current as { getDeviceId: () => Promise<string>; setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void; execute: (id: string, cb: (err: unknown, res: unknown) => void) => void };
      if (!sdk) throw new Error("UCW SDK not initialized");

      // Per Circle docs: must call getDeviceId + setAuthentication before execute
      await sdk.getDeviceId();
      const auth = ucwAuthRef.current;
      if (auth?.encryptionKey) {
        const ek: string = auth.encryptionKey;
        sdk.setAuthentication({ userToken: auth.userToken, encryptionKey: ek });
      }

      const execErr = (err: unknown) => {
        const msg = err instanceof Error ? err.message : (err as Record<string, string>)?.message || JSON.stringify(err);
        return new Error(msg);
      };

      await new Promise<void>((resolve, reject) => {
        sdk.execute(approve.challengeId, (err: unknown) => err ? reject(execErr(err)) : resolve());
      });

      await new Promise<void>((resolve, reject) => {
        sdk.execute(deposit.challengeId, (err: unknown) => err ? reject(execErr(err)) : resolve());
      });

      setWalletError("Waiting for Gateway balance to update…");
      await new Promise((r) => setTimeout(r, 15000));

      const balance = await fetchSessionBalance();
      setUcwBalance(balance);
      setWalletState(parseFloat(balance.gateway) >= parseFloat(planned) ? "ready_to_approve" : "needs_gateway_deposit");
      if (parseFloat(balance.gateway) >= parseFloat(planned)) setWalletError(null);
    } catch (e: unknown) {
      setWalletState("needs_gateway_deposit");
      setWalletError(e instanceof Error ? e.message : "Deposit failed.");
    }
  }, [planned]);

  // ── Submit chat ──
  const submitChat = useCallback(async () => {
    if (!prompt.trim()) return;

    // Run gating: must have wallet
    if (!walletInfo?.address) {
      setWalletOpen(true);
      return;
    }

    // Run gating: UCW wallet must have live SDK/auth to sign
    if (walletInfo.walletType === "circle_user_controlled" && (!ucwSdkRef.current || !ucwAuthRef.current)) {
      setWalletError("Reconnect wallet to sign x402 payments.");
      setWalletOpen(true);
      return;
    }

    // Run gating: UCW must have sufficient Gateway balance
    if (walletInfo.walletType === "circle_user_controlled" && ucwBalance) {
      if (parseFloat(ucwBalance.gateway) < parseFloat(planned)) {
        setWalletState("needs_gateway_deposit");
        setWalletOpen(true);
        return;
      }
    }

    setStatus("running");
    setError(null);
    setResult(null);

    const body = {
      goal: prompt.trim(),
      user_wallet: walletInfo.address,
      route_tier: "auto",
      budget_usdc: Number(budget),
      customer_wallet_type: walletInfo.walletType,
      customer_auth_method: "social",
    };

    try {
      const first = await fetch("/api/paylabs/discovery-runs/inline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // ── Handle 402: payment required ──
      if (first.status === 402) {
        const paymentRequired = first.headers.get("PAYMENT-REQUIRED");
        if (!paymentRequired) {
          setError("Payment challenge missing.");
          setStatus("error");
          return;
        }

        let challenge: Record<string, unknown>;
        try {
          challenge = JSON.parse(atob(paymentRequired));
        } catch {
          setError("Invalid payment challenge.");
          setStatus("error");
          return;
        }

        // Sign with appropriate wallet type
        setWalletState("approving");
        let paymentSignature: string;
        try {
          if (walletInfo.walletType === "circle_user_controlled" && ucwSdkRef.current) {
            paymentSignature = await signWithUcw({
              challenge,
              walletAddress: walletInfo.address,
              ucwSdk: ucwSdkRef.current as { getDeviceId: () => Promise<string>; setAuthentication: (auth: { userToken: string; encryptionKey: string }) => void; execute: (id: string, cb: (err: unknown, res: unknown) => void) => void },
              auth: ucwAuthRef.current,
            });
          } else if (walletInfo.walletType === "circle_user_controlled" && !ucwSdkRef.current) {
            // UCW wallet but SDK/auth lost (e.g. after refresh) — never fall back to EOA
            setError("Reconnect wallet to sign x402 payments.");
            setWalletOpen(true);
            setWalletState("connected");
            setStatus("error");
            return;
          } else {
            // EOA fallback — only for external_eoa wallets
            paymentSignature = await signWithEoa({ challenge, walletAddress: walletInfo.address });
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Signing failed.";
          setError(msg);
          setWalletState("ready_to_approve");
          setStatus("error");
          return;
        }

        // Retry with payment signature
        const paid = await fetch("/api/paylabs/discovery-runs/inline", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "PAYMENT-SIGNATURE": paymentSignature,
          },
          body: JSON.stringify(body),
        });

        const paidData = await paid.json().catch(() => ({}));
        if (!paid.ok) {
          setError((paidData as Record<string, string>)?.error || "Payment failed.");
          setWalletState("failed");
          setStatus("error");
          return;
        }

        setWalletState("paid");
        setResult(toSafeRunResult(paidData as Record<string, unknown>));
        setStatus("done");
        return;
      }

      // ── Handle non-402 responses ──
      const data = await first.json().catch(() => ({}));
      if (!first.ok) {
        setError((data as Record<string, string>)?.error || "Run failed.");
        setStatus("error");
        return;
      }

      setResult(toSafeRunResult(data as Record<string, unknown>));
      setStatus("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error.");
      setStatus("error");
    }
  }, [prompt, budget, walletInfo, ucwWalletId, ucwBalance, planned]);

  const resetChat = useCallback(() => {
    setPrompt("");
    setResult(null);
    setError(null);
    setStatus("idle");
  }, []);

  // ── Disconnect wallet ──
  const disconnectWallet = useCallback(() => {
    fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
    setUcwWalletId(null);
    setWalletInfo(null);
    setWalletState("not_connected");
    setUcwBalance(null);
    setWalletError(null);
  }, []);

  // Dev mode: show EOA fallback if ?eoa=1 in URL
  const showEoaFallback = typeof window !== "undefined" && window.location.search.includes("eoa=1");

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

  return (
    <div className="pl-app">
      <SidebarPanel analytics={analytics} />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />

          <button
            type="button"
            className={`pl-wallet-pill ${walletInfo?.address ? "connected" : ""}`}
            onClick={() => setWalletOpen(true)}
            title={walletInfo?.address || "Connect wallet"}
          >
            {walletInfo?.address ? (
              <>
                <span className="pl-wallet-dot" />
                <span className="pl-wallet-pill-address">{short(walletInfo.address)}</span>
                <span className="pl-wallet-pill-network">Arc</span>
                <span className="pl-wallet-pill-balance">
                  {ucwBalance?.usdc ?? "0.00"} USDC
                </span>
                <button
                  type="button"
                  className="pl-wallet-copy-btn"
                  onClick={copyWalletAddress}
                  aria-label="Copy wallet address"
                  title="Copy wallet address"
                >
                  {walletCopied ? "✓" : "⧉"}
                </button>
              </>
            ) : (
              <>
                <span className="pl-wallet-dot idle" />
                <span>Connect wallet</span>
              </>
            )}
          </button>
        </div>

        <section className="pl-hero">
          <h1>Ask PayLabs</h1>
          <p>Source Discovery, receipts, and x402 payments.</p>

          <div className="pl-search">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask for a route, receipt, or source-backed payment…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitChat();
                }
              }}
            />
            <div className="pl-search-actions">
<span className="pl-plan-auto">Plan: Auto</span>
              <div className="pl-budget">
                <span>Max budget</span>
                <input value={budget} onChange={(e) => setBudget(e.target.value)} type="number" step="0.001" min="0" />
                <small>USDC</small>
              </div>
              <button
                className="pl-run-btn"
                onClick={submitChat}
                disabled={status === "running" || !prompt.trim()}
              >
                {status === "running" ? "Running…" : "Run"}
              </button>
            </div>
          </div>

          <div className="pl-chips">
            <button onClick={() => setPrompt("Find the cheapest route under my budget")}>Cheapest route</button>
            <button onClick={() => setPrompt("Show my recent receipts")}>Recent receipts</button>
            <button onClick={() => setPrompt("Explain my last payment")}>Explain payment</button>
            <button onClick={() => setPrompt("Open global explorer")}>Global explorer</button>
          </div>
        </section>

        {/* Conversation area */}
        {(result || error || status === "running") && (
          <section className="pl-conversation">
            {prompt && <div className="pl-user-bubble">{prompt}</div>}

            <div className="pl-answer-card">
              <div className="pl-answer-head">
                <b>PayLabs</b>
                <span>
                  {status === "running" ? "Running…" : status === "error" ? "Error" : "Done"}
                </span>
              </div>

              {status === "running" && (
                <div className="pl-run-card">
                  <div><span>Plan</span><b>Auto</b></div>
                  <div><span>Budget</span><b>{budget} USDC</b></div>
                  <div><span>Planned</span><b>{planned} USDC</b></div>
                  <div className="pl-run-status">Processing…</div>
                </div>
              )}

              {error && <div className="pl-error-msg">{error}</div>}

              {result && <ResultCard result={result} onReset={resetChat} />}
            </div>
          </section>
        )}
      </main>

      <WalletConnectModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        walletState={walletState}
        walletInfo={walletInfo}
        ucwBalance={ucwBalance}
        budget={budget}
        plannedCost={planned}
        error={walletError}
        onConnectGoogle={connectGoogle}
        onConnectEmail={connectEmail}
        onConnectPin={connectPin}
        onConnectEoa={connectEoa}
        onDepositGateway={depositGateway}
        onApprove={() => { setWalletOpen(false); submitChat(); }}
        showEoaFallback={showEoaFallback}
        needsReconnectToSign={needsReconnectToSign}
        onReconnect={connectGoogle}
        debugLog={ucwDebug ? debugLog : undefined}
      />
    </div>
  );
}

// ─── Result Card ────────────────────────────────────────────

function ResultCard({ result, onReset }: { result: SafeRunResult; onReset: () => void }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  return (
    <div className="pl-result-card">
      <div className="pl-result-row">
        <span>Status</span>
        <b>{result.ok ? "Run completed" : "Run failed"}</b>
      </div>
      <div className="pl-result-row">
        <span>Tier</span>
        <b style={{ textTransform: "capitalize" }}>{result.tier || "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Entry</span>
        <b>{result.entryPaymentStatus || "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Paid edges</span>
        <b>{result.paidEdges}/{result.totalEdges}</b>
      </div>
      <div className="pl-result-row">
        <span>Planned</span>
        <b>{result.plannedCostUsdc != null ? `${result.plannedCostUsdc} USDC` : "—"}</b>
      </div>
      <div className="pl-result-row">
        <span>Receipt</span>
        <b>{result.receiptReady ? "Ready" : "Pending"}</b>
      </div>
      {result.reasoning && (
        <div className="pl-reasoning-block">
          <button
            className="pl-reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
          >
            {reasoningOpen ? "▾" : "▸"} Brain Thinking
          </button>
          {reasoningOpen && (
            <pre className="pl-reasoning-content">{result.reasoning}</pre>
          )}
        </div>
      )}
      {result.runId && (
        <div className="pl-result-links">
          <a href={`/dashboard?run=${result.runId}`}>View details</a>
          <button onClick={onReset} className="pl-new-run">New run</button>
        </div>
      )}
    </div>
  );
}
