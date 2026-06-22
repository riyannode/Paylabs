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
};

/** Persisted UCW session (survives OAuth redirect via cookie) */
type UcwSession = {
  deviceId: string;
  deviceToken: string;
  deviceEncryptionKey: string;
  userToken: string;
  encryptionKey: string;
  walletId: string;
  walletAddress: string;
};

// ─── Helpers ────────────────────────────────────────────────

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

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

/** Sign with Circle UCW via challenge-response */
async function signWithUcw(params: {
  challenge: Record<string, unknown>;
  walletAddress: string;
  walletId: string;
  userToken: string;
  ucwSdk: { execute: (challengeId: string, cb: (error: unknown, result: unknown) => void) => void };
}): Promise<string> {
  const { challenge, walletAddress, walletId, userToken, ucwSdk } = params;
  const { domain, types, message, requirement, x402Version } = buildEip712Params(challenge, walletAddress);

  // Step 1: Backend creates signTypedData challenge
  // UCW API expects EIP-712 data with EIP712Domain in types
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

  const signResp = await fetch("/api/paylabs/wallet/ucw?action=sign-challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userToken, walletId, data: signData }),
  });
  if (!signResp.ok) {
    const err = await signResp.json().catch(() => ({}));
    throw new Error(`Sign challenge failed: ${(err as Record<string, string>).error || signResp.status}`);
  }
  const { challengeId } = (await signResp.json()) as { challengeId: string };
  if (!challengeId) throw new Error("No challengeId returned from sign-challenge");

  // Step 2: Execute challenge via UCW SDK (user approves via Circle hosted UI)
  const signature: string = await new Promise((resolve, reject) => {
    ucwSdk.execute(challengeId, (error: unknown, result: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else {
        const sig = (result as Record<string, string>)?.signature;
        if (!sig) reject(new Error("No signature returned from UCW challenge"));
        else resolve(sig);
      }
    });
  });

  return buildPaymentPayload(challenge, requirement, message, signature, x402Version);
}

// ─── UCW Balance Fetcher ────────────────────────────────────

async function fetchUcwBalance(walletId: string, userToken: string, walletAddress: string): Promise<UcwBalance> {
  const [usdcResp, gwResp] = await Promise.all([
    fetch("/api/paylabs/wallet/ucw?action=balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletId, userToken }),
    }),
    fetch("/api/paylabs/wallet/ucw?action=gateway-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: walletAddress }),
    }),
  ]);

  let usdc = "0";
  let gateway = "0";

  if (usdcResp.ok) {
    const data = (await usdcResp.json()) as { balances: Array<{ amount: string; token: string }> };
    const usdcBalance = data.balances?.find((b) => b.token === "USDC");
    usdc = usdcBalance?.amount ?? "0";
  }

  if (gwResp.ok) {
    const data = (await gwResp.json()) as { balance: string };
    gateway = data.balance ?? "0";
  }

  return { usdc, gateway };
}

// ─── Main Component ─────────────────────────────────────────

export default function PayLabsChatClient({ analytics }: Props) {
  // Chat state
  const [prompt, setPrompt] = useState("");
  const [tier, setTier] = useState<"easy" | "normal" | "advanced">("easy");
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

  // UCW session (persisted in cookie across OAuth redirect)
  const [ucwSession, setUcwSession] = useState<UcwSession | null>(null);
  const ucwSdkRef = useRef<unknown>(null); // W3SSdk instance

  const planned = useMemo(() => TIER_COSTS[tier] || "0.000007", [tier]);

// Session is memory-only — no restoration on mount.

  // ── Connect via Google (UCW social login) ──
  const connectGoogle = useCallback(async () => {
    setWalletState("connecting");
    setWalletError(null);

    try {
      // Dynamic import — browser-only SDK
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      // Check if we have a saved session in memory
      if (ucwSession?.userToken && ucwSession?.walletId) {
        // Restore from memory
        setWalletInfo({
          address: ucwSession.walletAddress,
          walletType: "circle_user_controlled",
          network: "Arc Testnet",
        });
        setWalletState("connected");
        // Fetch balance
        const balance = await fetchUcwBalance(ucwSession.walletId, ucwSession.userToken, ucwSession.walletAddress);
        setUcwBalance(balance);
        // Check if Gateway balance is sufficient
        if (parseFloat(balance.gateway) < parseFloat(planned)) {
          setWalletState("needs_gateway_deposit");
        } else {
          setWalletState("ready_to_approve");
        }
        return;
      }

      // Step 1: Initialize SDK and get deviceId
      const onLoginComplete = (error: unknown, result: unknown) => {
        if (error) {
          setWalletState("not_connected");
          setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown error"}`);
          return;
        }
        const { userToken: ut, encryptionKey: ek } = result as { userToken: string; encryptionKey: string };
        setUcwSession((prev) => prev ? { ...prev, userToken: ut, encryptionKey: ek } : null);
      };

      const existingDeviceToken = ucwSession?.deviceToken ?? "";
      const existingDeviceEncKey = ucwSession?.deviceEncryptionKey ?? "";

      const sdk = new W3SSdk(
        {
          appSettings: { appId },
          loginConfigs: {
            deviceToken: existingDeviceToken,
            deviceEncryptionKey: existingDeviceEncKey,
            google: {
              clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
              redirectUri: typeof window !== "undefined" ? window.location.origin : "",
              selectAccountPrompt: true,
            },
          },
        },
        onLoginComplete,
      );
      ucwSdkRef.current = sdk;

      // Get deviceId (creates iframe session)
      const deviceId = await sdk.getDeviceId();

      // Step 2: Create device token via backend
      if (!existingDeviceToken) {
        const dtResp = await fetch("/api/paylabs/wallet/ucw?action=device-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId }),
        });
        if (!dtResp.ok) {
          const err = await dtResp.json().catch(() => ({}));
          throw new Error(`Device token failed: ${(err as Record<string, string>).error || dtResp.status}`);
        }
        const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as {
          deviceToken: string;
          deviceEncryptionKey: string;
        };

        // Session stored in memory only (no userToken yet — comes after OAuth)

        // Re-init SDK with device token
        sdk.updateConfigs({
          appSettings: { appId },
          loginConfigs: {
            deviceToken,
            deviceEncryptionKey,
            google: {
              clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
              redirectUri: typeof window !== "undefined" ? window.location.origin : "",
              selectAccountPrompt: true,
            },
          },
        });
      }

      // Step 3: Perform Google login (triggers OAuth redirect)
      const { SocialLoginProvider } = await import("@circle-fin/w3s-pw-web-sdk/dist/src/types");
      sdk.performLogin(SocialLoginProvider.GOOGLE);
      // After this, the page will redirect to Google OAuth
      // On return, the login callback fires and we restore from cookie
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, [planned]);

  // ── After UCW login completes: initialize user + get wallet ──
  const finalizeUcwLogin = useCallback(async (session: UcwSession) => {
    try {
      // Initialize user (creates wallet if new)
      const initResp = await fetch("/api/paylabs/wallet/ucw?action=initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken: session.userToken }),
      });
      if (!initResp.ok) {
        const err = await initResp.json().catch(() => ({}));
        throw new Error(`Initialize failed: ${(err as Record<string, string>).error || initResp.status}`);
      }
      const initData = (await initResp.json()) as { challengeId: string | null; alreadyExists: boolean };

      // If new user, execute wallet creation challenge
      if (initData.challengeId && ucwSdkRef.current) {
        const sdk = ucwSdkRef.current as { execute: (id: string, cb: (err: unknown, res: unknown) => void) => void };
        await new Promise<void>((resolve, reject) => {
          sdk.execute(initData.challengeId!, (err: unknown) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else resolve();
          });
        });
      }

      // List wallets to get walletId + address
      const listResp = await fetch("/api/paylabs/wallet/ucw?action=list-wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken: session.userToken }),
      });
      if (!listResp.ok) throw new Error("Failed to list wallets");
      const { wallets } = (await listResp.json()) as {
        wallets: Array<{ id: string; address: string; blockchain: string }>;
      };
      if (!wallets || wallets.length === 0) throw new Error("No wallets found after initialization");

      const wallet = wallets[0];
      const fullSession: UcwSession = { ...session, walletId: wallet.id, walletAddress: wallet.address };
      setUcwSession(fullSession);
      setWalletInfo({
        address: wallet.address,
        walletType: "circle_user_controlled",
        network: "Arc Testnet",
      });
      setWalletState("connected");

      // Fetch balance
      const balance = await fetchUcwBalance(wallet.id, session.userToken, wallet.address);
      setUcwBalance(balance);
      if (parseFloat(balance.gateway) < parseFloat(planned)) {
        setWalletState("needs_gateway_deposit");
      } else {
        setWalletState("ready_to_approve");
      }
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Wallet initialization failed.");
    }
  }, [planned]);

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
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      // Get deviceId first
      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk;

      // Create email device token via backend
      const dtResp = await fetch("/api/paylabs/wallet/ucw?action=email-device-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, email }),
      });
      if (!dtResp.ok) {
        const err = await dtResp.json().catch(() => ({}));
        throw new Error(`Email device token failed: ${(err as Record<string, string>).error || dtResp.status}`);
      }
      const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as {
        deviceToken: string;
        deviceEncryptionKey: string;
      };

      // Session stored in memory only

      // Update SDK with email device token — SDK will show OTP input
      sdk.updateConfigs(
        {
          appSettings: { appId },
          loginConfigs: { deviceToken, deviceEncryptionKey },
        },
        (error: unknown, result: unknown) => {
          if (error) {
            setWalletState("not_connected");
            setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown error"}`);
            return;
          }
          const { userToken: ut, encryptionKey: ek } = result as { userToken: string; encryptionKey: string };
          setUcwSession((prev) => {
            const updated = prev ? { ...prev, userToken: ut, encryptionKey: ek } : null;
            if (updated) finalizeUcwLogin(updated);
            return updated;
          });
        },
      );

      // Trigger OTP verification UI
      sdk.verifyOtp();
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Email login failed.");
    }
  }, []);

  // ── Connect via PIN ──
  const connectPin = useCallback(async () => {
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      const sdk = new W3SSdk({ appSettings: { appId } });
      const deviceId = await sdk.getDeviceId();
      ucwSdkRef.current = sdk;

      // Create user token via backend (userId = deviceId for PIN auth)
      const utResp = await fetch("/api/paylabs/wallet/ucw?action=user-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: deviceId }),
      });
      if (!utResp.ok) {
        const err = await utResp.json().catch(() => ({}));
        throw new Error(`User token failed: ${(err as Record<string, string>).error || utResp.status}`);
      }
      const { userToken, encryptionKey } = (await utResp.json()) as { userToken: string; encryptionKey: string };

      // Session stored in memory only
      setUcwSession({ deviceId, deviceToken: "", deviceEncryptionKey: "", userToken, encryptionKey: encryptionKey ?? "", walletId: "", walletAddress: "" });

      sdk.setAuthentication({ userToken, encryptionKey: encryptionKey ?? "" });

      // Initialize user — creates challenge for wallet + PIN setup
      const initResp = await fetch("/api/paylabs/wallet/ucw?action=initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken }),
      });
      if (!initResp.ok) throw new Error("Initialize failed");
      const initData = (await initResp.json()) as { challengeId: string | null; alreadyExists: boolean };

      if (initData.challengeId) {
        // New user — execute PIN setup challenge
        await new Promise<void>((resolve, reject) => {
          sdk.execute(initData.challengeId!, (err: unknown) => {
            if (err) reject(err instanceof Error ? err : new Error(String(err)));
            else resolve();
          });
        });
      }

      // List wallets
      const listResp = await fetch("/api/paylabs/wallet/ucw?action=list-wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken }),
      });
      if (!listResp.ok) throw new Error("Failed to list wallets");
      const { wallets } = (await listResp.json()) as { wallets: Array<{ id: string; address: string }> };
      if (!wallets || wallets.length === 0) throw new Error("No wallets found");

      const wallet = wallets[0];
      const fullSession: UcwSession = { deviceId, deviceToken: "", deviceEncryptionKey: "", userToken, encryptionKey: encryptionKey ?? "", walletId: wallet.id, walletAddress: wallet.address };
      setUcwSession(fullSession);
      setWalletInfo({ address: wallet.address, walletType: "circle_user_controlled", network: "Arc Testnet" });
      setWalletState("connected");

      const balance = await fetchUcwBalance(wallet.id, userToken, wallet.address);
      setUcwBalance(balance);
      if (parseFloat(balance.gateway) < parseFloat(planned)) {
        setWalletState("needs_gateway_deposit");
      } else {
        setWalletState("ready_to_approve");
      }
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "PIN login failed.");
    }
  }, [planned]);

  // ── Gateway deposit (UCW contract execution) ──
  const depositGateway = useCallback(async () => {
    if (!ucwSession) return;
    setWalletState("approving");
    setWalletError(null);
    try {
      const amountUsdc = parseFloat(planned) * 2; // deposit 2x planned cost as buffer
      const amountAtomic = Math.round(amountUsdc * 1_000_000).toString();

      const resp = await fetch("/api/paylabs/wallet/ucw?action=approve-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userToken: ucwSession.userToken,
          walletId: ucwSession.walletId,
          amountAtomic,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(`Deposit challenge failed: ${(err as Record<string, string>).error || resp.status}`);
      }
      const { approve, deposit } = (await resp.json()) as {
        approve: { challengeId: string };
        deposit: { challengeId: string };
      };

      const sdk = ucwSdkRef.current as { execute: (id: string, cb: (err: unknown, res: unknown) => void) => void };
      if (!sdk) throw new Error("UCW SDK not initialized");

      // Execute approve challenge
      await new Promise<void>((resolve, reject) => {
        sdk.execute(approve.challengeId, (err: unknown) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        });
      });

      // Execute deposit challenge
      await new Promise<void>((resolve, reject) => {
        sdk.execute(deposit.challengeId, (err: unknown) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        });
      });

      // Wait for Gateway balance to update (~15s)
      setWalletError("Waiting for Gateway balance to update…");
      await new Promise((r) => setTimeout(r, 15000));

      // Refresh balance
      const balance = await fetchUcwBalance(ucwSession.walletId, ucwSession.userToken, ucwSession.walletAddress);
      setUcwBalance(balance);

      if (parseFloat(balance.gateway) >= parseFloat(planned)) {
        setWalletState("ready_to_approve");
        setWalletError(null);
      } else {
        setWalletState("needs_gateway_deposit");
        setWalletError("Gateway balance still insufficient. Try again.");
      }
    } catch (e: unknown) {
      setWalletState("needs_gateway_deposit");
      setWalletError(e instanceof Error ? e.message : "Deposit failed.");
    }
  }, [ucwSession, planned]);

  // ── Submit chat ──
  const submitChat = useCallback(async () => {
    if (!prompt.trim()) return;

    // Run gating: must have wallet
    if (!walletInfo?.address) {
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
      route_tier: tier,
      budget_usdc: Number(budget),
      customer_wallet_type: walletInfo.walletType,
      ...(ucwSession ? { customer_auth_method: "social" as const } : {}),
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
          if (walletInfo.walletType === "circle_user_controlled" && ucwSession && ucwSdkRef.current) {
            paymentSignature = await signWithUcw({
              challenge,
              walletAddress: walletInfo.address,
              walletId: ucwSession.walletId,
              userToken: ucwSession.userToken,
              ucwSdk: ucwSdkRef.current as { execute: (id: string, cb: (err: unknown, res: unknown) => void) => void },
            });
          } else {
            // EOA fallback
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
  }, [prompt, tier, budget, walletInfo, ucwSession, ucwBalance, planned]);

  const resetChat = useCallback(() => {
    setPrompt("");
    setResult(null);
    setError(null);
    setStatus("idle");
  }, []);

  // ── Disconnect wallet ──
  const disconnectWallet = useCallback(() => {
    setUcwSession(null);
    setWalletInfo(null);
    setWalletState("not_connected");
    setUcwBalance(null);
    setWalletError(null);
  }, []);

  // Dev mode: show EOA fallback if ?eoa=1 in URL
  const showEoaFallback = typeof window !== "undefined" && window.location.search.includes("eoa=1");

  return (
    <div className="pl-app">
      <SidebarPanel analytics={analytics} />

      <main className="pl-main">
        <div className="pl-topbar">
          <div />
          <button className="pl-wallet-btn" onClick={() => setWalletOpen(true)}>
            {walletInfo ? short(walletInfo.address) : "Connect wallet"}
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
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as "easy" | "normal" | "advanced")}
              >
                <option value="easy">Easy</option>
                <option value="normal">Normal</option>
                <option value="advanced">Advanced</option>
              </select>
              <div className="pl-budget">
                <span>Budget</span>
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
                  <div><span>Tier</span><b>{tier}</b></div>
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
      />
    </div>
  );
}

// ─── Result Card ────────────────────────────────────────────

function ResultCard({ result, onReset }: { result: SafeRunResult; onReset: () => void }) {
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
      {result.runId && (
        <div className="pl-result-links">
          <a href={`/dashboard?run=${result.runId}`}>View details</a>
          <button onClick={onReset} className="pl-new-run">New run</button>
        </div>
      )}
    </div>
  );
}
