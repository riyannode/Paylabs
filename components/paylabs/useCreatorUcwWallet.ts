"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { WalletState, WalletInfo, UcwBalance } from "./WalletConnectModal";
import type { W3SSdk as CircleW3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { SocialLoginProvider } from "@circle-fin/w3s-pw-web-sdk/dist/src/types";

// ── Session helpers (server-side, tokens never touch client) ──

async function fetchSessionBalance(): Promise<UcwBalance> {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-balance", { method: "POST", credentials: "include" });
  if (!resp.ok) return { walletUsdc: "0", gatewayUsdc: null, source: "ucw" };
  const data = (await resp.json()) as { usdc: string };
  return { walletUsdc: data.usdc ?? "0", gatewayUsdc: null, source: "ucw" };
}

type SaveLoginData = {
  walletId: string | null;
  walletAddress: string | null;
  challengeId: string | null;
  error?: string;
};

type UcwSdk = CircleW3SSdk;

function safeDiagnosticMessage(value: unknown): string {
  if (value instanceof Error) return value.message.slice(0, 300);
  if (typeof value === "string") return value.slice(0, 300);
  if (value == null) return "unknown";
  return String(value).slice(0, 300);
}

function logPrepareGoogle(step: string, details: Record<string, unknown> = {}) {
  console.error(`[creator-ucw] ${step}`, { step, ...details });
}

function getCreatorUcwRedirectOrigin(): string {
  const configuredOrigin =
    process.env.NEXT_PUBLIC_PAYLABS_UCW_REDIRECT_ORIGIN ||
    process.env.NEXT_PUBLIC_PAYLABS_APP_URL ||
    window.location.origin;

  return new URL(configuredOrigin).origin;
}

type GoogleLoginConfigInput = {
  appId: string;
  googleClientId: string;
  origin: string;
  deviceToken: string;
  deviceEncryptionKey: string;
};

function buildGoogleLoginConfig({
  appId,
  googleClientId,
  origin,
  deviceToken,
  deviceEncryptionKey,
}: GoogleLoginConfigInput) {
  return {
    appSettings: { appId },
    loginConfigs: {
      deviceToken,
      deviceEncryptionKey,
      google: {
        clientId: googleClientId,
        redirectUri: origin,
        selectAccountPrompt: true,
      },
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertCreatorUcwRedirectOriginMatchesCurrentHost(origin: string) {
  const redirectHost = new URL(origin).host;
  if (redirectHost !== window.location.host) {
    throw new Error(`Creator Wallet Google redirect origin (${redirectHost}) must match the current host (${window.location.host}). Update NEXT_PUBLIC_PAYLABS_UCW_REDIRECT_ORIGIN or NEXT_PUBLIC_PAYLABS_APP_URL for this preview deployment.`);
  }
}

async function safeResponseError(resp: Response): Promise<string | number> {
  const err = (await resp.json().catch(() => ({}))) as { error?: string };
  const error = err.error;
  if (resp.status === 409 && error === "wallet_mode_conflict") {
    return "User Test Wallet is connected. Switch to Creator Wallet first.";
  }
  if (resp.status === 401 && (!error || error === "No session" || error === "no_session")) {
    return "Creator Wallet session expired. Reopen the modal and try again.";
  }
  return error || resp.status;
}

async function createUcwSessionOrThrow() {
  const resp = await fetch("/api/paylabs/wallet/ucw?action=session-create", {
    method: "POST",
    credentials: "include",
  });

  if (!resp.ok) {
    const detail = await safeResponseError(resp);
    throw new Error(`Creator wallet session failed: ${detail}`);
  }
}

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

  const resetGooglePreparation = useCallback(() => {
    clearLoginTimeout();
    prepareGooglePromiseRef.current = null;
    ucwGoogleReadyRef.current = false;
    setUcwGoogleReady(false);
    setUcwGoogleError(null);
  }, [clearLoginTimeout]);

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
      const detail = await safeResponseError(saveResp);
      setWalletState("not_connected");
      setWalletError(`Creator wallet login session failed: ${detail}`);
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
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
      const origin = getCreatorUcwRedirectOrigin();

      logPrepareGoogle("prepare_google_start", {
        hasCircleAppId: !!appId,
        hasGoogleClientId: !!googleClientId,
        origin,
      });

      try {
        const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
        if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID is missing. Configure it to enable Creator Wallet Google login.");
        if (!googleClientId) throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is missing. Configure it to enable Creator Wallet Google login.");
        assertCreatorUcwRedirectOriginMatchesCurrentHost(origin);

        try {
          await createUcwSessionOrThrow();
        } catch (e: unknown) {
          logPrepareGoogle("session_create_failed");
          throw e;
        }

        let sdk: UcwSdk;
        sdk = new W3SSdk(
          buildGoogleLoginConfig({ appId, googleClientId, origin, deviceToken: "", deviceEncryptionKey: "" }) as unknown as ConstructorParameters<typeof W3SSdk>[0],
          (error: unknown, result: unknown) => handleGoogleLoginCallback(sdk, error, result),
        );

        let deviceId: string;
        try {
          deviceId = await withTimeout(
            sdk.getDeviceId(),
            15_000,
            "Creator Wallet device setup timed out. Please retry.",
          );
        } catch (e: unknown) {
          logPrepareGoogle("get_device_id_failed", { message: safeDiagnosticMessage(e) });
          throw e;
        }

        const dtResp = await withTimeout(
          fetch("/api/paylabs/wallet/ucw?action=device-token", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId }),
          }),
          15_000,
          "Creator Wallet device token request timed out. Please retry.",
        );
        if (!dtResp.ok) {
          const detail = await safeResponseError(dtResp);
          logPrepareGoogle("device_token_failed", { status: dtResp.status });
          throw new Error(`Creator wallet device setup failed: ${detail}`);
        }
        const { deviceToken, deviceEncryptionKey } = (await dtResp.json()) as { deviceToken: string; deviceEncryptionKey: string };

        const saveDeviceResp = await withTimeout(
          fetch("/api/paylabs/wallet/ucw?action=session-save-device", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId, deviceToken, deviceEncryptionKey }),
          }),
          15_000,
          "Creator Wallet device session request timed out. Please retry.",
        );
        if (!saveDeviceResp.ok) {
          const detail = await safeResponseError(saveDeviceResp);
          logPrepareGoogle("session_save_device_failed", { status: saveDeviceResp.status });
          throw new Error(`Creator wallet device session failed: ${detail}`);
        }

        try {
          sdk.updateConfigs(
            buildGoogleLoginConfig({ appId, googleClientId, origin, deviceToken, deviceEncryptionKey }) as unknown as Parameters<UcwSdk["updateConfigs"]>[0],
            (error: unknown, result: unknown) => handleGoogleLoginCallback(sdk, error, result),
          );
        } catch (e: unknown) {
          logPrepareGoogle("update_configs_failed", { message: safeDiagnosticMessage(e) });
          throw e;
        }

        ucwSdkRef.current = sdk;
        ucwGoogleReadyRef.current = true;
        setUcwGoogleReady(true);
        logPrepareGoogle("prepare_google_ready", { origin });
      } catch (e: unknown) {
        ucwGoogleReadyRef.current = false;
        setUcwGoogleReady(false);
        logPrepareGoogle("prepare_google_failed", {
          message: safeDiagnosticMessage(e),
          hasCircleAppId: !!appId,
          hasGoogleClientId: !!googleClientId,
          origin,
        });
        setUcwGoogleError(e instanceof Error ? e.message : "Creator Wallet login setup failed. Please retry.");
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
            const fin = (await finResp.json()) as { walletId: string; walletAddress: string; usdc: string };
            setUcwWalletId(fin.walletId);
            setWalletInfo({ address: fin.walletAddress, walletType: "circle_user_controlled", network: "Arc Testnet" });
            setUcwBalance({ walletUsdc: fin.usdc ?? "0", gatewayUsdc: null, source: "ucw" });
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
          const origin = getCreatorUcwRedirectOrigin();
          if (googleClientId) assertCreatorUcwRedirectOriginMatchesCurrentHost(origin);
          let callbackFired = false;
          let sdk: UcwSdk;
          sdk = new W3SSdk(
            googleClientId
              ? buildGoogleLoginConfig({ appId, googleClientId, origin, deviceToken, deviceEncryptionKey }) as unknown as ConstructorParameters<typeof W3SSdk>[0]
              : { appSettings: { appId }, loginConfigs: { deviceToken, deviceEncryptionKey } } as unknown as ConstructorParameters<typeof W3SSdk>[0],
            async (error: unknown, result: unknown) => {
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
              if (!saveResp.ok) {
                const detail = await safeResponseError(saveResp);
                setWalletState("not_connected");
                setWalletError(`Creator wallet login session failed: ${detail}`);
                return;
              }
              const saveData = (await saveResp.json()) as SaveLoginData;
              const cbs = { setWalletState, setWalletError, setUcwWalletId, setWalletInfo, setUcwBalance };
              await finalizeWalletAfterLogin(saveData, sdk, cbs, { userToken, encryptionKey });
            },
          );
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

  const startGoogleLogin = useCallback((preserveConnectedWallet: boolean) => {
    const sdk = ucwSdkRef.current;
    if (!ucwGoogleReadyRef.current || !sdk) return false;

    setWalletState("connecting");
    setWalletError(null);
    clearLoginTimeout();
    loginTimeoutRef.current = setTimeout(() => {
      setWalletState(preserveConnectedWallet ? "connected" : "not_connected");
      setWalletError("Login popup was blocked or timed out. Try again.");
      loginTimeoutRef.current = null;
    }, 55_000);

    try {
      sdk.performLogin(SocialLoginProvider.GOOGLE);
      return true;
    } catch (e: unknown) {
      clearLoginTimeout();
      setWalletState(preserveConnectedWallet ? "connected" : "not_connected");
      setWalletError(e instanceof Error ? e.message : "Connection failed.");
      return false;
    }
  }, [clearLoginTimeout]);

  const retryPrepareGoogleLogin = useCallback(async () => {
    setUcwGoogleError(null);
    ucwGoogleReadyRef.current = false;
    ucwSdkRef.current = null;
    setUcwGoogleReady(false);
    await prepareGoogleLogin();
  }, [prepareGoogleLogin]);

  // ── Connect via Google ──
  const connectGoogle = useCallback(async () => {
    if (walletState === "connecting" || ucwGooglePreparing) return;

    setWalletError(null);

    if (!ucwGoogleReadyRef.current || !ucwSdkRef.current) {
      setWalletState("connecting");
      try {
        await prepareGoogleLogin();
      } catch (e: unknown) {
        setWalletState("not_connected");
        setWalletError(e instanceof Error ? e.message : "Creator Wallet login setup failed. Please retry.");
        return;
      }
    }

    const started = startGoogleLogin(false);
    if (!started) {
      setWalletState("not_connected");
      setWalletError("Creator Wallet login was prepared but could not start. Please try again.");
    }
  }, [walletState, ucwGooglePreparing, prepareGoogleLogin, startGoogleLogin]);

  // ── Connect via Email OTP ──
  const connectEmail = useCallback(async (email: string) => {
    if (walletState === "connecting") return;
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      resetGooglePreparation();
      await createUcwSessionOrThrow();
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
  }, [walletState, resetGooglePreparation]);

  // ── Connect via PIN ──
  const connectPin = useCallback(async () => {
    if (walletState === "connecting") return;
    setWalletState("connecting");
    setWalletError(null);
    try {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const appId = process.env.NEXT_PUBLIC_CIRCLE_APP_ID;
      if (!appId) throw new Error("NEXT_PUBLIC_CIRCLE_APP_ID not configured");

      resetGooglePreparation();
      await createUcwSessionOrThrow();
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
  }, [walletState, resetGooglePreparation]);

  const reconnectGoogle = useCallback(async () => {
    if (walletState === "connecting") return;

    if (!ucwGoogleReadyRef.current || !ucwSdkRef.current) {
      setWalletState("connecting");
      setWalletError("Preparing creator wallet login...");
      try {
        await prepareGoogleLogin();
      } catch (e: unknown) {
        setWalletState(walletInfo?.address ? "connected" : "not_connected");
        setWalletError(e instanceof Error ? e.message : "Creator wallet login preparation failed.");
        return;
      }
    }

    startGoogleLogin(!!walletInfo?.address);
  }, [walletState, walletInfo?.address, prepareGoogleLogin, startGoogleLogin]);

  // ── Reconnect by auth method ──
  const reconnect = useCallback(() => {
    if (authMethod === "google") reconnectGoogle();
    else if (authMethod === "email") {
      setWalletError("Email reconnect is not available. Use Google or PIN.");
    }
    else if (authMethod === "pin") connectPin();
  }, [authMethod, reconnectGoogle, connectPin]);

  const disconnect = useCallback(async () => {
    await fetch("/api/paylabs/wallet/ucw?action=session-destroy", {
      method: "POST",
      credentials: "include",
    }).catch(() => {});

    ucwSdkRef.current = null;
    ucwAuthRef.current = null;
    ucwGoogleReadyRef.current = false;
    setUcwGoogleReady(false);
    setWalletInfo(null);
    setUcwWalletId(null);
    setUcwBalance(null);
    setWalletState("not_connected");
    setWalletError(null);
    setAuthMethod(null);
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
    defaultShowEmailInput,
    ucwGooglePreparing,
    ucwGoogleReady,
    ucwGoogleError,
    prepareGoogleLogin,
    retryPrepareGoogleLogin,
    connectGoogle,
    connectEmail,
    connectPin,
    reconnect,
    disconnect,
    refreshBalance,
  };
}
