"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { WalletState, WalletInfo, UcwBalance } from "./WalletConnectModal";
import type { W3SSdk as CircleW3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";

// ── Session helpers (server-side, tokens never touch client) ──

async function fetchSessionBalance(): Promise<UcwBalance> {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-balance", { method: "POST", credentials: "include" });
  if (!resp.ok) return { walletUsdc: "0", gatewayUsdc: "0", source: "ucw" };
  const data = (await resp.json()) as { usdc: string; gateway: string };
  return { walletUsdc: data.usdc ?? "0", gatewayUsdc: data.gateway ?? "0", source: "ucw" };
}

type SaveLoginData = {
  walletId: string | null;
  walletAddress: string | null;
  challengeId: string | null;
  error?: string;
};

type UcwSdk = CircleW3SSdk;

type FinalizeCallbacks = {
  setWalletState: (s: WalletState) => void;
  setWalletError: (e: string | null) => void;
  setUcwWalletId: (id: string | null) => void;
  setWalletInfo: (info: WalletInfo | null) => void;
  setUcwBalance: (b: UcwBalance | null) => void;
};

async function finalizeWalletAfterLogin(
  saveData: SaveLoginData,
  sdk: UcwSdk,
  cbs: FinalizeCallbacks,
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
        sdk.setAuthentication({ userToken: auth.userToken, encryptionKey: auth.encryptionKey });
      }
      sdk.setLocalizations({
        signatureRequest: { title: "Create Wallet", description: "Set up your secure wallet on Arc Testnet" },
      });
      await new Promise<void>((resolve, reject) => {
        sdk.execute(saveData.challengeId!, (err: unknown, result: unknown) => {
          if (err) reject(new Error(err instanceof Error ? err.message : (err as Record<string, string>)?.message || JSON.stringify(err)));
          else resolve();
        });
      });
      const finalizeResp = await fetch("/api/paylabs/wallet/ucw?action=session-finalize-wallet", { method: "POST", credentials: "include" });
      const finalized = (await finalizeResp.json().catch(() => ({}))) as { walletId?: string; walletAddress?: string; error?: string };
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
    cbs.setWalletError("Login succeeded, but Circle returned no wallet address.");
    return false;
  }

  cbs.setUcwWalletId(saveData.walletId);
  cbs.setWalletInfo({ address: saveData.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
  cbs.setWalletState("connected");
  const balance = await fetchSessionBalance();
  cbs.setUcwBalance(balance);
  return true;
}

// ── Hook ──

export function useCreatorUcwWallet() {
  const [walletState, setWalletState] = useState<WalletState>("not_connected");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [ucwBalance, setUcwBalance] = useState<UcwBalance | null>(null);
  const [ucwWalletId, setUcwWalletId] = useState<string | null>(null);
  const [authMethod, setAuthMethod] = useState<"google" | "email" | "pin" | null>(null);
  const [depositStatus, setDepositStatus] = useState<string | null>(null);
  const [defaultShowEmailInput, setDefaultShowEmailInput] = useState(false);
  const [ucwGooglePreparing, setUcwGooglePreparing] = useState(false);
  const [ucwGoogleReady, setUcwGoogleReady] = useState(false);
  const [ucwGoogleError, setUcwGoogleError] = useState<string | null>(null);

  const ucwSdkRef = useRef<UcwSdk | null>(null);
  const ucwAuthRef = useRef<{ userToken: string; encryptionKey?: string } | null>(null);
  const ucwGoogleReadyRef = useRef(false);
  const prepareGooglePromiseRef = useRef<Promise<void> | null>(null);
  const loginTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ucwCanSign = walletInfo?.walletType === "circle_user_controlled"
    ? !!ucwSdkRef.current && !!ucwAuthRef.current
    : !!walletInfo?.address;

  const needsReconnectToSign =
    walletInfo?.walletType === "circle_user_controlled" &&
    !!walletInfo.address &&
    !ucwCanSign;

  const clearLoginTimeout = useCallback(() => {
    if (loginTimeoutRef.current) {
      clearTimeout(loginTimeoutRef.current);
      loginTimeoutRef.current = null;
    }
  }, []);

  const handleGoogleLoginCallback = useCallback(async (sdk: UcwSdk, error: unknown, result: unknown) => {
    clearLoginTimeout();
    if (error) {
      setWalletState("not_connected");
      setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`);
      return;
    }

    const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
    ucwAuthRef.current = { userToken, encryptionKey };
    setAuthMethod("google");

    const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, encryptionKey, authMethod: "google" }),
    });
    if (!saveResp.ok) {
      setWalletState("not_connected");
      setWalletError("Failed to save login session");
      return;
    }

    const saveData = (await saveResp.json()) as SaveLoginData;
    const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
    await finalizeWalletAfterLogin(saveData, sdk, cbs, { userToken, encryptionKey });
  }, [clearLoginTimeout]);

  const prepareGoogleLogin = useCallback(async () => {
    if (ucwGoogleReadyRef.current) return;
    if (prepareGooglePromiseRef.current) return prepareGooglePromiseRef.current;

    const prepare = (async () => {
      setUcwGooglePreparing(true);
      setUcwGoogleError(null);
      try {
        const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
        const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
        if (!appId) throw new Error("Creator wallet login is not configured.");

        const sessionResp = await fetch("/api/paylabs/wallet/ucw?action=session-create", { method: "POST", credentials: "include" });
        if (!sessionResp.ok) throw new Error("Creator wallet session failed.");

        const sdk = new W3SSdk({ appSettings: { appId } });
        const deviceId = await sdk.getDeviceId();

        const dtResp = await fetch("/api/paylabs/wallet/ucw?action=device-token", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId }),
        });
        if (!dtResp.ok) throw new Error("Creator wallet device setup failed.");
        const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

        const saveDeviceResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
        });
        if (!saveDeviceResp.ok) throw new Error("Creator wallet device session failed.");

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
          (error: unknown, result: unknown) => handleGoogleLoginCallback(sdk, error, result),
        );

        ucwSdkRef.current = sdk;
        ucwGoogleReadyRef.current = true;
        setUcwGoogleReady(true);
      } catch (e: unknown) {
        ucwGoogleReadyRef.current = false;
        setUcwGoogleReady(false);
        const message = e instanceof Error ? e.message : "Creator wallet login preparation failed.";
        setUcwGoogleError(message);
        throw e;
      } finally {
        setUcwGooglePreparing(false);
        prepareGooglePromiseRef.current = null;
      }
    })();

    prepareGooglePromiseRef.current = prepare;
    return prepare;
  }, [handleGoogleLoginCallback]);

  useEffect(() => {
    return () => clearLoginTimeout();
  }, [clearLoginTimeout]);

  // ── Session restore (UCW only) ──
  useEffect(() => {
    let cancelled = false;
    let oauthTimeout: ReturnType<typeof setTimeout> | null = null;

    const restore = async () => {
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
        if (cancelled) return;

        if (data.walletId && data.walletAddress && data.hasUserToken) {
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
              ucwSdkRef.current = sdk;

              const authResp = await fetch("/api/paylabs/wallet/ucw?action=session-get-auth", {
                method: "POST", credentials: "include", headers: { "X-Requested-With": "ucw-sdk-restore" },
              });
              if (authResp.ok && !cancelled) {
                const authData = (await authResp.json()) as { userToken: string; encryptionKey: string | null; authMethod: string };
                if (authData.encryptionKey) {
                  ucwAuthRef.current = { userToken: authData.userToken, encryptionKey: authData.encryptionKey };
                  sdk.setAuthentication({ userToken: authData.userToken, encryptionKey: authData.encryptionKey });
                } else {
                  ucwAuthRef.current = { userToken: authData.userToken };
                }
              }
            }
          } catch { /* non-fatal — user can reconnect */ }

          if (!cancelled) {
            const balance = await fetchSessionBalance();
            setUcwBalance(balance);
          }
          return;
        }

        // User token but no wallet → try finalize
        if (data.hasUserToken && (!data.walletId || !data.walletAddress)) {
          const finResp = await fetch("/api/paylabs/wallet/ucw?action=session-finalize-wallet", { method: "POST", credentials: "include" });
          if (finResp.ok && !cancelled) {
            const fin = (await finResp.json()) as { walletId: string; walletAddress: string; usdc: string; gateway: string };
            setUcwWalletId(fin.walletId);
            setWalletInfo({ address: fin.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
            setUcwBalance({ walletUsdc: fin.usdc ?? "0", gatewayUsdc: fin.gateway ?? "0", source: "ucw" });
            setWalletState("connected");
            return;
          }
          fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
          setWalletState("not_connected");
          return;
        }

        // Device token but no user token + no OAuth hash → stale session
        if (data.hasDeviceToken && !data.hasUserToken) {
          const hasOAuthHash = window.location.hash.includes("access_token") || window.location.hash.includes("id_token");
          if (!hasOAuthHash) {
            fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            setWalletState("not_connected");
            return;
          }
          // OAuth redirect in progress — restore SDK
          setWalletState("connecting");
          const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
          const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
          if (!appId || cancelled) return;

          const dtResp = await fetch("/api/paylabs/wallet/ucw?action=session-get-device", { method: "POST", credentials: "include" });
          if (!dtResp.ok || cancelled) { setWalletState("not_connected"); return; }
          const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

          const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
          let callbackFired = false;
          const sdk = new W3SSdk({
            appSettings: { appId },
            loginConfigs: {
              deviceToken,
              deviceEncryptionKey,
              ...(googleClientId ? { google: { clientId: googleClientId, redirectUri: window.location.origin, selectAccountPrompt: true } } : {}),
            },
          }, async (error: unknown, result: unknown) => {
            callbackFired = true;
            if (error) { setWalletState("not_connected"); setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`); return; }
            const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
            ucwAuthRef.current = { userToken, encryptionKey };
            if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
            setAuthMethod("google");
            const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
              method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userToken, encryptionKey, authMethod: "google" }),
            });
            if (!saveResp.ok) { setWalletState("not_connected"); setWalletError("Failed to save login session"); return; }
            const saveData = (await saveResp.json()) as SaveLoginData;
            const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
            await finalizeWalletAfterLogin(saveData, sdk, cbs, { userToken, encryptionKey });
          });
          ucwSdkRef.current = sdk;

          oauthTimeout = setTimeout(() => {
            if (!callbackFired && !cancelled) {
              setWalletState("not_connected");
              setWalletError("Login timed out. Please try again.");
              fetch("/api/paylabs/wallet/ucw?action=session-destroy", { method: "POST", credentials: "include" }).catch(() => {});
            }
          }, 10000);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setWalletState("not_connected");
          setWalletError(`Restore failed: ${e instanceof Error ? e.message : "Unknown error"}`);
        }
      }
    };
    restore();
    return () => { cancelled = true; if (oauthTimeout) clearTimeout(oauthTimeout); };
  }, []);

  // ── Connect via Google ──
  const connectGoogle = useCallback(() => {
    if (walletState === "connecting") return;

    const sdk = ucwSdkRef.current;
    if (!ucwGoogleReadyRef.current || !sdk) {
      setWalletError("Preparing creator wallet login. Try again in a moment.");
      prepareGoogleLogin().catch(() => {});
      return;
    }

    setWalletState("connecting");
    setWalletError(null);
    clearLoginTimeout();
    loginTimeoutRef.current = setTimeout(() => {
      setWalletState("not_connected");
      setWalletError("Login popup was blocked or timed out. Try again.");
      loginTimeoutRef.current = null;
    }, 55_000);

    try {
      sdk.performLogin(SocialLoginProvider.GOOGLE);
    } catch (e: unknown) {
      clearLoginTimeout();
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
    }
  }, [walletState, prepareGoogleLogin, clearLoginTimeout]);

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
      ucwSdkRef.current = sdk;

      const dtResp = await fetch("/api/paylabs/wallet/ucw?action=email-device-token", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, email }),
      });
      if (!dtResp.ok) throw new Error("Email device token failed");
      const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

      await fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
      });

      sdk.updateConfigs(
        { appSettings: { appId }, loginConfigs: { deviceToken, deviceEncryptionKey } },
        async (error: unknown, result: unknown) => {
          if (error) { setWalletState("not_connected"); setWalletError(`Login failed: ${error instanceof Error ? error.message : "Unknown"}`); return; }
          const { userToken, encryptionKey } = result as { userToken: string; encryptionKey: string };
          ucwAuthRef.current = encryptionKey ? { userToken, encryptionKey } : { userToken };
          setAuthMethod("email");
          const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userToken, encryptionKey, authMethod: "email" }),
          });
          if (!saveResp.ok) { setWalletState("not_connected"); setWalletError("Failed to save login"); return; }
          const saveData = (await saveResp.json()) as SaveLoginData;
          const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
          await finalizeWalletAfterLogin(saveData, sdk, cbs, { userToken, encryptionKey });
        },
      );
      sdk.verifyOtp();
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "Email login failed.");
    }
  }, [walletState]);

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
      ucwSdkRef.current = sdk;

      const userId = deviceId;
      const createResp = await fetch("/api/paylabs/wallet/ucw?action=create-user", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({}));
        if ((err as Record<string, number>).code !== 155106) throw new Error(`Create user failed: ${(err as Record<string, string>).error || createResp.status}`);
      }

      const utResp = await fetch("/api/paylabs/wallet/ucw?action=user-token", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!utResp.ok) throw new Error("User token failed");
      const { userToken, encryptionKey } = (await utResp.json()) as { userToken: string; encryptionKey: string };
      ucwAuthRef.current = encryptionKey ? { userToken, encryptionKey } : { userToken };

      if (encryptionKey) sdk.setAuthentication({ userToken, encryptionKey });

      setAuthMethod("pin");
      const saveResp = await fetch("/api/paylabs/wallet/ucw?action=session-save-login", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken, encryptionKey, authMethod: "pin" }),
      });
      if (!saveResp.ok) throw new Error("Failed to save login session");
      const saveData = (await saveResp.json()) as SaveLoginData;
      const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
      await finalizeWalletAfterLogin(saveData, sdk, cbs, encryptionKey ? { userToken, encryptionKey } : undefined);
    } catch (e: unknown) {
      setWalletState("not_connected");
      setWalletError(e instanceof Error ? e.message : "PIN login failed.");
    }
  }, [walletState]);

  // ── Reconnect by auth method ──
  const reconnect = useCallback(() => {
    if (authMethod === "google") connectGoogle();
    else if (authMethod === "email") { setDefaultShowEmailInput(true); }
    else if (authMethod === "pin") connectPin();
  }, [authMethod, connectGoogle, connectPin]);

  // ── Gateway deposit (no-op for creator — kept for prop compatibility) ──
  const depositGateway = useCallback(async (_amountAtomic: string) => {
    // Creator wallet does not support Gateway deposit.
    // This is intentionally a no-op.
  }, []);

  // ── Refresh balance ──
  const refreshBalance = useCallback(async () => {
    const balance = await fetchSessionBalance();
    setUcwBalance(balance);
  }, []);

  return {
    walletState,
    walletInfo,
    ucwBalance,
    walletError,
    needsReconnectToSign,
    authMethod,
    depositStatus,
    defaultShowEmailInput,
    ucwGooglePreparing,
    ucwGoogleReady,
    ucwGoogleError,
    prepareGoogleLogin,
    connectGoogle,
    connectEmail,
    connectPin,
    reconnect,
    depositGateway,
    refreshBalance,
  };
}
