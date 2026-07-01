"use client";

import { useState, useEffect, useCallback, useRef } from "react";

type DcwStep = "auth" | "creating" | "wallet" | "deposit" | "error";

type DcwWalletInfo = {
  walletId: string;
  address: string;
  chain: string;
};

type DcwBalanceInfo = {
  walletUsdc: string | null;   // on-chain USDC (null if fetch failed)
  walletBalanceStatus?: "ok" | "unavailable"; // from Circle SDK
  gatewayUsdc: string;         // Gateway Balance
  pendingBatchUsdc?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onWalletReady?: (wallet: DcwWalletInfo) => void;
  onBalanceUpdate?: (balance: DcwBalanceInfo) => void;
  plannedCost?: string;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asDecimal(value?: string | null): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";

async function copyToClipboard(value: string) {
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = value;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textArea);
      return ok;
    } catch {
      return false;
    }
  }
}

function DcwInfoRow({
  label,
  value,
  children,
  copyValue,
  muted,
  icon,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
  copyValue?: string | null;
  muted?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="pl-info-row-v3">
      <span className="pl-row-icon-v3" aria-hidden="true">{icon}</span>
      <span className="pl-row-label-v3">{label}</span>
      <b className={muted ? "muted" : ""}>
        {children ?? value}
        {copyValue && (
          <button
            type="button"
            className="pl-copy-v3"
            onClick={() => navigator.clipboard?.writeText(copyValue)}
            aria-label="Copy"
          >
            ⎘
          </button>
        )}
      </b>
    </div>
  );
}

export default function DcwModal({ open, onClose, onWalletReady, onBalanceUpdate, plannedCost = "0.000015" }: Props) {
  const [step, setStep] = useState<DcwStep>("auth");
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState<DcwWalletInfo | null>(null);
  const [balance, setBalance] = useState<DcwBalanceInfo>({ walletUsdc: null, gatewayUsdc: "0" });
  const [error, setError] = useState<string | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [activeTab, setActiveTab] = useState<"balances" | "topup">("balances");
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [showPasskeyForm, setShowPasskeyForm] = useState(false);
  const [walletCopied, setWalletCopied] = useState(false);
  const googleInitialized = useRef(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  // Deposit state
  const [depositAmount, setDepositAmount] = useState("");
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  const x402Balance = asDecimal(balance.gatewayUsdc);
  const plannedCostNum = asDecimal(plannedCost);
  const needsTopUp = x402Balance < plannedCostNum;
  const recommendedTopUp = Math.max(plannedCostNum - x402Balance, plannedCostNum);
  const recommendedStr = recommendedTopUp > 0 ? recommendedTopUp.toFixed(6) : "0.000001";
  const walletAddress = wallet?.address ?? "";

  async function handleCopyWalletAddress() {
    if (!walletAddress) return;

    const ok = await copyToClipboard(walletAddress);
    if (!ok) return;

    setWalletCopied(true);
    window.setTimeout(() => setWalletCopied(false), 1800);
  }

  // ── Refresh Balance ───────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    try {
      const resp = await fetch("/api/paylabs/dcw/balance", { credentials: "include" });
      const data = await resp.json();
      if (data.ok) {
        const newBalance: DcwBalanceInfo = {
          walletUsdc: data.wallet?.usdc ?? null,
          walletBalanceStatus: data.wallet?.walletBalanceStatus ?? "unavailable",
          gatewayUsdc: data.gateway?.balanceUsdc ?? (data.gateway?.ok === false ? null : "0"),
          pendingBatchUsdc: data.gateway?.pendingBatchUsdc || "0",
        };
        setBalance(newBalance);
        onBalanceUpdate?.(newBalance);
      }
    } catch {}
  }, [onBalanceUpdate]);

  // Check existing session on open
  useEffect(() => {
    if (!open) return;
    setShowPasskeyForm(false);
    checkSession();
  }, [open]);

  const checkSession = useCallback(async () => {
    try {
      const resp = await fetch("/api/paylabs/auth/session");
      const data = await resp.json();
      if (data.ok && data.authenticated) {
        if (data.hasWallet && data.walletAddress) {
          setWallet({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
          setStep("deposit");
          refreshBalance();
          onWalletReady?.({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
        } else {
          setStep("creating");
          createWallet();
        }
      }
    } catch {
      // No session — stay on auth step
    }
  }, [onWalletReady]);

  // ── Google Sign-In ─────────────────────────────────────────
  const handleGoogleSignIn = useCallback(async (idToken: string) => {
    setIsGoogleLoading(true);
    setError(null);

    try {
      const resp = await fetch("/api/paylabs/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ idToken }),
      });
      const data = await resp.json();

      if (!data.ok) {
        setError(data.error || "Google Sign-In failed");
        setStep("error");
        return;
      }

      if (data.hasWallet && data.walletAddress) {
        setWallet({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
        setStep("deposit");
        refreshBalance();
        onWalletReady?.({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
      } else {
        setStep("creating");
        createWallet();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Google Sign-In failed");
      setStep("error");
    } finally {
      setIsGoogleLoading(false);
    }
  }, [onWalletReady]);

  const renderGoogleButton = useCallback(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    const g = (window as unknown as Record<string, unknown>).google as
      | { accounts?: { id?: { initialize: Function; renderButton: Function } } }
      | undefined;

    if (!clientId || !g?.accounts?.id || !googleButtonRef.current) return;

    if (!googleInitialized.current) {
      googleInitialized.current = true;
      g.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => {
          handleGoogleSignIn(response.credential);
        },
        ux_mode: "popup",
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_button: false,
      });
    }

    googleButtonRef.current.replaceChildren();
    g.accounts.id.renderButton(googleButtonRef.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: googleButtonRef.current.offsetWidth || 320,
    });
  }, [handleGoogleSignIn]);

  // ── Load Google Identity Services ───────────────────────────
  useEffect(() => {
    if (!open) return;
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) return;

    const existing = document.getElementById("google-identity-script");
    if (!existing) {
      const script = document.createElement("script");
      script.id = "google-identity-script";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = renderGoogleButton;
      document.head.appendChild(script);
    }

    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      renderGoogleButton();
      if (googleInitialized.current || attempts >= 30) clearInterval(interval);
    }, 100);

    return () => clearInterval(interval);
  }, [open, renderGoogleButton]);

  useEffect(() => {
    if (!open || step !== "auth") return;
    const id = window.setTimeout(() => {
      renderGoogleButton();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, step, renderGoogleButton]);

  // ── Passkey Registration ──────────────────────────────────
  const handlePasskeyRegister = useCallback(async () => {
    if (!email.includes("@")) return;
    setIsRegistering(true);
    setError(null);

    try {
      const challengeResp = await fetch("/api/paylabs/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, step: "challenge" }),
      });
      const challengeData = await challengeResp.json();

      if (!challengeData.ok) {
        if (challengeData.error?.includes("already registered")) {
          await handlePasskeyAuthenticate();
          return;
        }
        setError(challengeData.error || "Failed to start registration");
        setStep("error");
        return;
      }

      const { startRegistration } = await import("@simplewebauthn/browser");
      let credential;
      try {
        credential = await startRegistration({ optionsJSON: challengeData.options });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("cancelled") || msg.includes("NotAllowed")) {
          setError("Passkey registration cancelled.");
          setStep("auth");
          return;
        }
        throw e;
      }

      const verifyResp = await fetch("/api/paylabs/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, step: "verify", credential }),
      });
      const verifyData = await verifyResp.json();

      if (!verifyData.ok) {
        setError(verifyData.error || "Registration verification failed");
        setStep("error");
        return;
      }

      setStep("creating");
      createWallet();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Registration failed");
      setStep("error");
    } finally {
      setIsRegistering(false);
    }
  }, [email]);

  // ── Passkey Authentication ────────────────────────────────
  const handlePasskeyAuthenticate = useCallback(async () => {
    if (!email.includes("@")) return;
    setError(null);

    try {
      const challengeResp = await fetch("/api/paylabs/auth/passkey/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, step: "challenge" }),
      });
      const challengeData = await challengeResp.json();

      if (!challengeData.ok) {
        setError(challengeData.error || "No passkey found. Register first.");
        return;
      }

      const { startAuthentication } = await import("@simplewebauthn/browser");
      let credential;
      try {
        credential = await startAuthentication({ optionsJSON: challengeData.options });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("cancelled") || msg.includes("NotAllowed")) {
          setError("Authentication cancelled.");
          return;
        }
        throw e;
      }

      const verifyResp = await fetch("/api/paylabs/auth/passkey/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, step: "verify", credential }),
      });
      const verifyData = await verifyResp.json();

      if (!verifyData.ok) {
        setError(verifyData.error || "Authentication failed");
        return;
      }

      if (verifyData.hasWallet && verifyData.walletAddress) {
        setWallet({ walletId: "", address: verifyData.walletAddress, chain: "ARC-TESTNET" });
        setStep("deposit");
        refreshBalance();
        onWalletReady?.({ walletId: "", address: verifyData.walletAddress, chain: "ARC-TESTNET" });
      } else {
        setStep("creating");
        createWallet();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    }
  }, [email, onWalletReady]);

  // ── Email OTP: Send Code ────────────────────────────────
  const handleSendOtp = useCallback(async () => {
    if (!email.includes("@")) return;
    setIsSendingOtp(true);
    setError(null);

    try {
      const resp = await fetch("/api/paylabs/auth/otp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      const data = await resp.json();

      if (!data.ok) {
        setError(data.error || "Failed to send code");
        return;
      }

      setOtpSent(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to send code");
    } finally {
      setIsSendingOtp(false);
    }
  }, [email]);

  // ── Email OTP: Verify Code ──────────────────────────────
  const handleVerifyOtp = useCallback(async () => {
    if (!email.includes("@") || otpCode.length !== 6) return;
    setIsVerifyingOtp(true);
    setError(null);

    try {
      const resp = await fetch("/api/paylabs/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, code: otpCode }),
      });
      const data = await resp.json();

      if (!data.ok) {
        setError(data.error || "Verification failed");
        return;
      }

      if (data.hasWallet && data.walletAddress) {
        setWallet({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
        setStep("deposit");
        refreshBalance();
        onWalletReady?.({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
      } else {
        setStep("creating");
        createWallet();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setIsVerifyingOtp(false);
    }
  }, [email, otpCode, onWalletReady]);

  // ── Create Wallet (after auth) ────────────────────────────
  const createWallet = useCallback(async () => {
    try {
      const resp = await fetch("/api/paylabs/dcw/create-wallet", { method: "POST" });
      const data = await resp.json();

      if (!data.ok) {
        setError(data.error || "Failed to create wallet");
        setStep("error");
        return;
      }

      const w: DcwWalletInfo = { walletId: data.walletId, address: data.address, chain: data.chain };
      setWallet(w);
      setStep("deposit");
      onWalletReady?.(w);
      refreshBalance();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
      setStep("error");
    }
  }, [onWalletReady]);

  // ── Deposit to Gateway (two-phase: approve → deposit) ────
  const [depositTxId, setDepositTxId] = useState<string | null>(null);
  const [approveTxId, setApproveTxId] = useState<string | null>(null);
  const [depositState, setDepositState] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const depositTxIdRef = useRef<string | null>(null);
  const depositInFlightRef = useRef(false);
  const depositFlowIdRef = useRef<string | null>(null);
  const approveIdempotencyKeyRef = useRef<string | null>(null);
  const depositIdempotencyKeyRef = useRef<string | null>(null);
  const flowActive =
    isDepositing ||
    depositInFlightRef.current ||
    ["approve_pending", "approve_complete", "deposit_pending", "deposit_complete"].includes(depositState ?? "") ||
    (!!approveTxId && depositState !== "complete" && depositState !== "failed");

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      depositInFlightRef.current = false;
      depositFlowIdRef.current = null;
      approveIdempotencyKeyRef.current = null;
      depositIdempotencyKeyRef.current = null;
    };
  }, []);

  const handleDeposit = useCallback(async () => {
    if (depositInFlightRef.current) return;

    const amount = parseFloat(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setDepositError("Enter a valid amount");
      return;
    }
    depositInFlightRef.current = true;
    depositFlowIdRef.current = crypto.randomUUID();
    approveIdempotencyKeyRef.current = crypto.randomUUID();
    depositIdempotencyKeyRef.current = crypto.randomUUID();
    setIsDepositing(true);
    setDepositError(null);
    setDepositTxId(null);
    setApproveTxId(null);
    setDepositState(null);
    depositTxIdRef.current = null;

    // Clear any existing poll
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    try {
      // Phase 1: Submit approve only
      const resp = await fetch("/api/paylabs/dcw/deposit-gateway", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountUsdc: amount,
          depositFlowId: depositFlowIdRef.current,
          approveIdempotencyKey: approveIdempotencyKeyRef.current,
          depositIdempotencyKey: depositIdempotencyKeyRef.current,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        setDepositError(data.error || "Deposit failed");
        setIsDepositing(false);
        depositInFlightRef.current = false;
        depositFlowIdRef.current = null;
        approveIdempotencyKeyRef.current = null;
        depositIdempotencyKeyRef.current = null;
        return;
      }
      setDepositAmount("");
      setApproveTxId(data.approveTxId);
      if (typeof data.depositIdempotencyKey === "string") {
        depositIdempotencyKeyRef.current = data.depositIdempotencyKey;
      }
      setDepositState("approve_pending");

      const amt = amount;

      // Phase 2: Poll GET endpoint — it manages the approve→deposit state machine server-side
      pollRef.current = setInterval(async () => {
        try {
          const params = new URLSearchParams({
            approveTxId: data.approveTxId,
            amountUsdc: String(amt),
          });
          if (depositFlowIdRef.current) params.set("depositFlowId", depositFlowIdRef.current);
          if (depositIdempotencyKeyRef.current) params.set("depositIdempotencyKey", depositIdempotencyKeyRef.current);
          // Include depositTxId if we already have it from a previous poll response
          if (depositTxIdRef.current) params.set("depositTxId", depositTxIdRef.current);

          const statusResp = await fetch(
            `/api/paylabs/dcw/deposit-gateway?${params.toString()}`,
            { credentials: "include" }
          );
          const statusData = await statusResp.json();

          if (statusData.state) {
            setDepositState(statusData.state);

            // Capture depositTxId from server response (submitted after approve COMPLETE)
            if (statusData.depositTxId && !depositTxIdRef.current) {
              depositTxIdRef.current = statusData.depositTxId;
              setDepositTxId(statusData.depositTxId);
            }

            // Terminal states — stop polling
            if (statusData.state === "complete" || statusData.state === "failed") {
              if (statusData.state === "failed") {
                const safeReason =
                  typeof statusData.reason === "string"
                    ? statusData.reason.slice(0, 180)
                    : null;
                setDepositError(safeReason || "Gateway deposit failed. Check details and retry.");
              }
              setIsDepositing(false);
              depositInFlightRef.current = false;
              depositFlowIdRef.current = null;
              approveIdempotencyKeyRef.current = null;
              depositIdempotencyKeyRef.current = null;
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
              if (statusData.state === "complete") {
                await refreshBalance();
              }
              // Clear state after 8s
              setTimeout(() => {
                setDepositTxId(null);
                setApproveTxId(null);
                setDepositState(null);
                depositTxIdRef.current = null;
              }, 8000);
            }
          }
        } catch { /* poll failed — will retry */ }
      }, 5000);
    } catch (e: unknown) {
      setDepositError(e instanceof Error ? e.message : "Deposit failed");
      setIsDepositing(false);
      depositInFlightRef.current = false;
      depositFlowIdRef.current = null;
      approveIdempotencyKeyRef.current = null;
      depositIdempotencyKeyRef.current = null;
    }
  }, [depositAmount, refreshBalance]);



  if (!open) return null;

  return (
    <div className="pl-dcw-popover-overlay" onClick={onClose}>
      <div className="pl-wallet-modal-v3 pl-dcw-modal pl-dcw-popover-modal" onClick={(e) => e.stopPropagation()}>
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">×</button>

        <div className="pl-dcw-header">
          <h3>PayLabs Wallet</h3>
          <p className="muted">Used for automatic x402 payments.</p>
        </div>

        {/* ── Step: Auth (Google + Passkey) ─────────────── */}
        {step === "auth" && (
          <div className="pl-dcw-step">
            <div className="pl-login-stack-v3">
              <div style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>
                  PayLabs Wallet
                </div>
                <div style={{ fontSize: 13, color: "#64748b", marginTop: 4, lineHeight: 1.5 }}>
                  Used for automatic x402 payments.
                </div>
              </div>

              {/* Hidden Google SDK render target */}
              <div ref={googleButtonRef} style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 0, height: 0, overflow: "hidden" }} aria-busy={isGoogleLoading} />

              <button
                className="pl-login-option-v3"
                onClick={() => {
                  const g = (window as unknown as Record<string, unknown>).google as
                    | { accounts?: { id?: { prompt: Function } } }
                    | undefined;
                  if (g?.accounts?.id) {
                    g.accounts.id.prompt();
                  }
                }}
                disabled={isGoogleLoading}
              >
                <span className="pl-login-icon-v3 google"><GoogleIcon /></span>
                <b>Continue with Google</b>
              </button>

              <button
                className="pl-login-option-v3"
                onClick={() => setShowPasskeyForm((value) => !value)}
                aria-expanded={showPasskeyForm}
              >
                <span className="pl-login-icon-v3"><PasskeyIcon /></span>
                <b>Use Passkey</b>
              </button>
            </div>

            {showPasskeyForm && (
              <div className="pl-dcw-email-section visible" style={{ marginTop: 8 }}>
                <label className="pl-dcw-label">Email for passkey</label>
                <input
                  className="pl-email-otp-input"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && email.includes("@")) handlePasskeyRegister();
                  }}
                />
                <button
                  className="pl-primary-v3"
                  onClick={handlePasskeyRegister}
                  disabled={!email.includes("@") || isRegistering}
                >
                  {isRegistering ? "Creating passkey…" : "Register with Passkey"}
                </button>
                <button
                  className="pl-eoa-fallback-v3"
                  onClick={handlePasskeyAuthenticate}
                  disabled={!email.includes("@")}
                  style={{ marginTop: 4 }}
                >
                  Already have a passkey? Sign in
                </button>
              </div>
            )}

            {error && (
              <p className="muted" style={{ fontSize: 12, color: "var(--danger, #ef4444)", textAlign: "center", marginTop: 4 }}>
                {error}
              </p>
            )}
          </div>
        )}

        {/* ── Step: Creating wallet ─────────────────────── */}
        {step === "creating" && (
          <div className="pl-dcw-step" style={{ textAlign: "center", padding: 32 }}>
            <div className="pl-deposit-step-icon" style={{ fontSize: 32 }}>⏳</div>
            <p>Creating your wallet…</p>
          </div>
        )}

        {/* ── Step: Wallet connected — Balances / Top up tabs ── */}
        {step === "deposit" && wallet && (
          <div className="pl-wallet-content-v3 pl-dcw-step">
            <div className="pl-connected-hero-v3">
              <div className="pl-connected-status-v3">
                <span className="pl-connected-dot-v3" />
                <span>PayLabs Wallet connected</span>
              </div>
              <div className="pl-wallet-connected-address-row">
                <code className="pl-wallet-connected-address">
                  {shortAddr(walletAddress)}
                </code>
                <button
                  type="button"
                  className={`pl-copy-pill ${walletCopied ? "pl-copy-pill-copied" : ""}`}
                  onClick={handleCopyWalletAddress}
                  disabled={!walletAddress}
                  aria-label={walletCopied ? "Wallet address copied" : "Copy wallet address"}
                >
                  {walletCopied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>

            {/* Tab bar */}
            <div className="pl-wallet-tabs-v3" style={{ marginBottom: 12 }}>
              <button
                className={activeTab === "balances" ? "active" : ""}
                onClick={() => setActiveTab("balances")}
              >
                Balances
              </button>
              <button
                className={activeTab === "topup" ? "active" : ""}
                onClick={() => setActiveTab("topup")}
              >
                Deposit to Gateway
              </button>
            </div>

            {/* Tab 1: Balances */}
            {activeTab === "balances" && (
              <>
                <div className="pl-summary-card-v3">
                  <DcwInfoRow label="Wallet" icon={<WalletIcon />}>
                    <span className="data-mono">{shortAddr(wallet.address)}</span>
                  </DcwInfoRow>
                  <DcwInfoRow label="Type" value="PayLabs Wallet" icon={<CardIcon />} />
                  <DcwInfoRow label="Network" value="Arc Testnet" icon={<GlobeIcon />} />

                  {balance.walletUsdc != null ? (
                    <DcwInfoRow label="Wallet USDC" value={`${balance.walletUsdc} USDC`} icon={<DollarIcon />} />
                  ) : balance.walletBalanceStatus === "unavailable" ? (
                    <DcwInfoRow label="Wallet USDC" value="Syncing…" muted icon={<DollarIcon />} />
                  ) : (
                    <DcwInfoRow label="Wallet USDC" value="0.00 USDC" muted icon={<DollarIcon />} />
                  )}

                  <DcwInfoRow label="Gateway Balance" icon={<BoltIcon />}>
                    <span style={{ color: x402Balance > 0 ? "var(--success, #22c55e)" : undefined }}>
                      {balance.gatewayUsdc != null ? `${x402Balance.toFixed(6)} USDC` : "Checking…"}
                    </span>
                  </DcwInfoRow>
                  <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>Powered by Circle Gateway</span>

                  {asDecimal(balance.pendingBatchUsdc) > 0 && (
                    <DcwInfoRow label="Pending Batch" value={`${asDecimal(balance.pendingBatchUsdc).toFixed(6)} USDC`} icon={<ClockIcon />} />
                  )}

                  <DcwInfoRow label="Planned Cost" value={`${plannedCostNum.toFixed(6)} USDC`} icon={<TargetIcon />} />
                </div>

                {/* Status */}
                <div style={{ padding: "8px 0", fontSize: 13, fontWeight: 600 }}>
                  {needsTopUp ? (
                    <span style={{ color: "var(--warn, #f59e0b)" }}>⚠ Gateway deposit needed</span>
                  ) : (
                    <span style={{ color: "var(--success, #22c55e)" }}>✓ Gateway Balance ready</span>
                  )}
                </div>

                {/* Actions */}
                {needsTopUp ? (
                  <button className="pl-primary-v3" onClick={() => setActiveTab("topup")}>
                    Deposit to Gateway
                  </button>
                ) : (
                  <>
                    <button className="pl-primary-v3" onClick={onClose}>
                      Close
                    </button>
                  </>
                )}

                <button className="pl-eoa-fallback-v3" onClick={refreshBalance} style={{ marginTop: 4 }}>
                  Refresh Balance
                </button>
              </>
            )}

            {/* Tab 2: Deposit to Gateway */}
            {activeTab === "topup" && (
              <>
                <div className="pl-summary-card-v3">
                  {balance.walletUsdc != null ? (
                    <DcwInfoRow label="Wallet USDC" value={`${balance.walletUsdc} USDC`} icon={<DollarIcon />} />
                  ) : balance.walletBalanceStatus === "unavailable" ? (
                    <DcwInfoRow label="Wallet USDC" value="Syncing…" muted icon={<DollarIcon />} />
                  ) : (
                    <DcwInfoRow label="Wallet USDC" value="0.00 USDC" muted icon={<DollarIcon />} />
                  )}
                  <DcwInfoRow
                    label="Gateway Balance"
                    icon={<BoltIcon />}
                    value={balance.gatewayUsdc != null ? `${x402Balance.toFixed(6)} USDC` : "Checking…"}
                  />
                  <DcwInfoRow label="Planned Cost" value={`${plannedCostNum.toFixed(6)} USDC`} icon={<TargetIcon />} />
                  <DcwInfoRow label="Recommended" value={`${recommendedStr} USDC`} icon={<CheckIcon />} />
                </div>

                {/* Deposit to Gateway */}
                <div className="pl-deposit-panel-flat">
                  <div className="pl-deposit-title">Deposit to Gateway</div>
                  <p className="pl-deposit-helper">
                    Move USDC from your PayLabs Wallet into Gateway Balance for automatic x402 payments.
                  </p>
                  {balance.gatewayUsdc == null && (
                    <p style={{ color: "var(--warn, #f59e0b)", fontSize: 11, marginBottom: 8 }}>
                      ⚠ Gateway balance check failed. Refresh to retry.
                    </p>
                  )}
                  <div className="pl-deposit-input-row">
                    <input
                      className="pl-deposit-input"
                      type="number"
                      step="0.000001"
                      min="0"
                      placeholder="Amount USDC"
                      value={depositAmount}
                      onChange={(e) => { setDepositAmount(e.target.value); setDepositError(null); }}
                      disabled={flowActive}
                    />
                    <button
                      type="button"
                      className="pl-primary-v3 pl-deposit-button"
                      onClick={handleDeposit}
                      disabled={flowActive || !depositAmount}
                    >
                      {flowActive ? "Depositing…" : "Deposit"}
                    </button>
                  </div>
                  {depositError && (
                    <p style={{ color: "var(--error, #ef4444)", fontSize: 11, marginTop: 6 }}>{depositError}</p>
                  )}
                  {depositState && (
                    <p style={{
                      color: depositState === "complete" ? "var(--success, #22c55e)" : depositState === "failed" ? "var(--error, #ef4444)" : "var(--info, #3b82f6)",
                      fontSize: 11, marginTop: 6,
                    }}>
                      {depositState === "approve_pending" && "Approving Gateway deposit..."}
                      {depositState === "approve_complete" && "Approval confirmed. Depositing to Gateway..."}
                      {depositState === "deposit_pending" && "Gateway deposit submitted..."}
                      {depositState === "deposit_complete" && "Gateway deposit submitted..."}
                      {depositState === "complete" && "Gateway Balance updated."}
                      {depositState === "failed" && "Deposit failed."}
                      {!["approve_pending", "approve_complete", "deposit_pending", "deposit_complete", "complete", "failed"].includes(depositState) && `⏳ ${depositState}…`}
                    </p>
                  )}

                </div>

                <div className="pl-faucet-card">
                  <div>
                    <div className="pl-faucet-title">Need test USDC?</div>
                    <div className="pl-faucet-subtitle">
                      Copy your wallet address above, then open Circle Faucet.
                    </div>
                  </div>
                  <a
                    className="pl-faucet-button"
                    href={CIRCLE_FAUCET_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Circle Faucet ↗
                  </a>
                </div>

                <button className="pl-primary-v3" onClick={refreshBalance} style={{ marginTop: 12 }}>
                  Refresh Balance
                </button>

                <button
                  className="pl-eoa-fallback-v3"
                  onClick={() => setActiveTab("balances")}
                  style={{ marginTop: 4 }}
                >
                  ← Back to Balances
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Step: Error ───────────────────────────────── */}
        {step === "error" && (
          <div className="pl-dcw-step">
            <div className="pl-wallet-error-v3">{error}</div>
            <button className="pl-primary-v3" onClick={() => { setStep("auth"); setError(null); }} style={{ marginTop: 12 }}>
              Try Again
            </button>
          </div>
        )}
        {step === "deposit" && (
          <p className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 12 }}>
            Automatic x402 payments use your PayLabs Wallet balance.
          </p>
        )}
        <style jsx>{`
          .pl-google-button-host { width: 100%; min-height: 44px; display: grid; place-items: center; }
          .pl-passkey-pill { width: 100%; }
          .pl-dcw-email-section { width: 100%; }
          .pl-dcw-deposit-card { margin-top: 12px; background: #fff; }
          .pl-dcw-deposit-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: stretch; }
          .pl-dcw-address-code { display: block; overflow-wrap: anywhere; font-size: 12px; }
          @media (max-width: 520px) {
            .pl-dcw-deposit-controls { grid-template-columns: 1fr; }
            .pl-dcw-deposit-controls :global(.pl-primary-v3) { width: 100%; }
            .pl-google-button-host { justify-items: stretch; }
          }
        `}</style>
      </div>
    </div>
  );
}

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5Z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.2 4 9.5 8.5 6.3 14.7Z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-7.9l-6.5 5C9.4 39.5 16.1 44 24 44Z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.4-2.3 4.3-4.1 5.6l6.2 5.2C36.9 39.3 44 34 44 24c0-1.3-.1-2.4-.4-3.5Z" />
    </svg>
  );
}

function MailIcon() {
  return <Svg><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></Svg>;
}

function PasskeyIcon() {
  return <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
}

function WalletIcon() {
  return <Svg><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M16 14h.01" /></Svg>;
}

function DollarIcon() {
  return <Svg><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Svg>;
}

function BoltIcon() {
  return <Svg><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></Svg>;
}

function TargetIcon() {
  return <Svg><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></Svg>;
}

function CheckIcon() {
  return <Svg><polyline points="20 6 9 17 4 12" /></Svg>;
}

function ClockIcon() {
  return <Svg><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></Svg>;
}

function CardIcon() {
  return <Svg><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></Svg>;
}

function GlobeIcon() {
  return <Svg><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></Svg>;
}
