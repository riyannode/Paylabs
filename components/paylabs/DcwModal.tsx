"use client";

import { useState, useEffect, useCallback, useRef } from "react";

type DcwStep = "auth" | "creating" | "wallet" | "deposit" | "error";

type DcwWalletInfo = {
  walletId: string;
  address: string;
  chain: string;
};

type DcwBalanceInfo = {
  walletUsdc: string | null;   // on-chain USDC (null if not fetched)
  gatewayUsdc: string;         // x402 Balance (Gateway)
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

export default function DcwModal({ open, onClose, onWalletReady, onBalanceUpdate, plannedCost = "0.000015" }: Props) {
  const [step, setStep] = useState<DcwStep>("auth");
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState<DcwWalletInfo | null>(null);
  const [balance, setBalance] = useState<DcwBalanceInfo>({ walletUsdc: null, gatewayUsdc: "0" });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [activeTab, setActiveTab] = useState<"balances" | "topup">("balances");
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const googleInitialized = useRef(false);

  // Deposit state
  const [depositAmount, setDepositAmount] = useState("");
  const [isDepositing, setIsDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  const x402Balance = asDecimal(balance.gatewayUsdc);
  const plannedCostNum = asDecimal(plannedCost);
  const needsTopUp = x402Balance < plannedCostNum;
  const recommendedTopUp = Math.max(plannedCostNum - x402Balance, plannedCostNum);
  const recommendedStr = recommendedTopUp > 0 ? recommendedTopUp.toFixed(6) : "0.000001";

  // Check existing session on open
  useEffect(() => {
    if (!open) return;
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

  // ── Load Google Identity Services ───────────────────────────
  useEffect(() => {
    if (!open) return;
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || googleInitialized.current) return;

    // Load GIS script if not already loaded
    const existing = document.getElementById("google-identity-script");
    if (!existing) {
      const script = document.createElement("script");
      script.id = "google-identity-script";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    // Poll until google.accounts.id is available, then initialize
    let attempts = 0;
    const maxAttempts = 30; // 3 seconds max
    const interval = setInterval(() => {
      attempts++;
      const g = (window as unknown as Record<string, unknown>).google as
        | { accounts?: { id?: { initialize: Function } } }
        | undefined;

      if (g?.accounts?.id) {
        clearInterval(interval);
        if (!googleInitialized.current) {
          googleInitialized.current = true;
          g.accounts.id.initialize({
            client_id: clientId,
            callback: (response: { credential: string }) => {
              handleGoogleSignIn(response.credential);
            },
            auto_select: false,
            cancel_on_tap_outside: true,
          });
        }
      }

      if (attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [open, handleGoogleSignIn]);

  /** Trigger Google One Tap / sign-in prompt */
  const triggerGoogleSignIn = useCallback(() => {
    setIsGoogleLoading(true);
    setError(null);
    const g = (window as unknown as Record<string, unknown>).google as
      | { accounts?: { id?: { prompt: Function } } }
      | undefined;
    if (g?.accounts?.id) {
      g.accounts.id.prompt(() => {
        // Prompt dismissed or callback fired
        setIsGoogleLoading(false);
      });
    } else {
      setError("Google Sign-In not loaded. Please try again.");
      setIsGoogleLoading(false);
    }
  }, []);

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

  // ── Refresh Balance ───────────────────────────────────────
  const refreshBalance = useCallback(async () => {
    try {
      const resp = await fetch("/api/paylabs/dcw/balance", { credentials: "include" });
      const data = await resp.json();
      if (data.ok) {
        const newBalance: DcwBalanceInfo = {
          walletUsdc: data.wallet?.usdc ?? null,
          gatewayUsdc: data.gateway?.balanceUsdc || "0",
          pendingBatchUsdc: data.gateway?.pendingBatchUsdc || "0",
        };
        setBalance(newBalance);
        onBalanceUpdate?.(newBalance);
      }
    } catch {}
  }, [onBalanceUpdate]);

  // ── Deposit to Gateway ────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    const amount = parseFloat(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setDepositError("Enter a valid amount");
      return;
    }
    setIsDepositing(true);
    setDepositError(null);
    try {
      const resp = await fetch("/api/paylabs/dcw/deposit-gateway", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountUsdc: amount }),
      });
      const data = await resp.json();
      if (!data.ok) {
        setDepositError(data.error || "Deposit failed");
        return;
      }
      setDepositAmount("");
      // Refresh balance after successful deposit
      await refreshBalance();
    } catch (e: unknown) {
      setDepositError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setIsDepositing(false);
    }
  }, [depositAmount, refreshBalance]);

  const handleCopy = useCallback(() => {
    if (wallet?.address) {
      navigator.clipboard?.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [wallet]);

  if (!open) return null;

  return (
    <div className="pl-wallet-overlay-v3" onClick={onClose}>
      <div className="pl-dcw-modal" onClick={(e) => e.stopPropagation()}>
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">×</button>

        <div className="pl-dcw-header">
          <span className="pl-dcw-badge">DCW</span>
          <h3>Auto-Pay Wallet</h3>
          <p className="muted">No popups. No signing. Just works.</p>
        </div>

        {/* ── Step: Auth (Google + Passkey) ─────────────── */}
        {step === "auth" && (
          <div className="pl-dcw-step">
            <div className="pl-login-stack-v3">
              <button
                className="pl-login-option-v3"
                onClick={triggerGoogleSignIn}
                disabled={isGoogleLoading}
              >
                <span className="pl-login-icon-v3 google"><GoogleIcon /></span>
                <b>{isGoogleLoading ? "Signing in…" : "Continue with Google"}</b>
              </button>

              <button
                className="pl-login-option-v3"
                onClick={() => {
                  const el = document.querySelector(".pl-dcw-email-section");
                  if (el) el.classList.toggle("visible");
                }}
              >
                <span className="pl-login-icon-v3"><PasskeyIcon /></span>
                <b>Passkey</b>
              </button>
            </div>

            {error && (
              <p className="muted" style={{ fontSize: 12, color: "var(--danger, #ef4444)", textAlign: "center", marginTop: 4 }}>
                {error}
              </p>
            )}

            {/* Passkey section (collapsed by default) */}
            <div className="pl-dcw-email-section" style={{ marginTop: 8 }}>
              <label className="pl-dcw-label">Your email</label>
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
                {isRegistering ? "Creating passkey…" : "🔐 Register with Passkey"}
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

            <p className="muted" style={{ fontSize: 11, marginTop: 4, textAlign: "center" }}>
              Auto-pay wallet. No popups, no signing.
            </p>
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
          <div className="pl-dcw-step">
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
                Top up x402
              </button>
            </div>

            {/* Tab 1: Balances */}
            {activeTab === "balances" && (
              <>
                <div className="pl-dcw-wallet-card">
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Address</span>
                    <b className="data-mono">
                      {shortAddr(wallet.address)}
                      <button className="pl-copy-v3" onClick={handleCopy} aria-label="Copy">
                        {copied ? "✓" : "⎘"}
                      </button>
                    </b>
                  </div>
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Type</span>
                    <b>DCW</b>
                  </div>
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Network</span>
                    <b>{wallet.chain}</b>
                  </div>

                  {balance.walletUsdc != null ? (
                    <div className="pl-dcw-wallet-row">
                      <span className="muted">Wallet USDC</span>
                      <b>{balance.walletUsdc} USDC</b>
                    </div>
                  ) : (
                    <div className="pl-dcw-wallet-row">
                      <span className="muted">Wallet USDC</span>
                      <b className="muted">not available</b>
                    </div>
                  )}

                  <div className="pl-dcw-wallet-row">
                    <span className="muted">x402 Balance</span>
                    <b style={{ color: x402Balance > 0 ? "var(--success, #22c55e)" : undefined }}>
                      {x402Balance.toFixed(6)} USDC
                    </b>
                  </div>
                  <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>Powered by Circle Gateway</span>

                  {asDecimal(balance.pendingBatchUsdc) > 0 && (
                    <div className="pl-dcw-wallet-row">
                      <span className="muted">Pending Batch</span>
                      <b>{asDecimal(balance.pendingBatchUsdc).toFixed(6)} USDC</b>
                    </div>
                  )}

                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Planned Cost</span>
                    <b>{plannedCostNum.toFixed(6)} USDC</b>
                  </div>
                </div>

                {/* Status */}
                <div style={{ padding: "8px 0", fontSize: 13, fontWeight: 600 }}>
                  {needsTopUp ? (
                    <span style={{ color: "var(--warn, #f59e0b)" }}>⚠ Top up needed</span>
                  ) : (
                    <span style={{ color: "var(--success, #22c55e)" }}>✓ Ready to run</span>
                  )}
                </div>

                {/* Actions */}
                {needsTopUp ? (
                  <button className="pl-primary-v3" onClick={() => setActiveTab("topup")}>
                    Top up x402 Balance
                  </button>
                ) : (
                  <>
                    <button className="pl-primary-v3" onClick={onClose}>
                      Close
                    </button>
                    <button
                      className="pl-eoa-fallback-v3"
                      onClick={() => setActiveTab("topup")}
                      style={{ marginTop: 4 }}
                    >
                      Add more x402 Balance
                    </button>
                  </>
                )}

                <button className="pl-eoa-fallback-v3" onClick={refreshBalance} style={{ marginTop: 4 }}>
                  Refresh Balance
                </button>
              </>
            )}

            {/* Tab 2: Top up x402 */}
            {activeTab === "topup" && (
              <>
                <div className="pl-dcw-wallet-card">
                  {balance.walletUsdc != null ? (
                    <div className="pl-dcw-wallet-row">
                      <span className="muted">Wallet USDC</span>
                      <b>{balance.walletUsdc} USDC</b>
                    </div>
                  ) : (
                    <div className="pl-dcw-wallet-row">
                      <span className="muted">Wallet USDC</span>
                      <b className="muted">not available</b>
                    </div>
                  )}
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">x402 Balance</span>
                    <b>{x402Balance.toFixed(6)} USDC</b>
                  </div>
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Planned Cost</span>
                    <b>{plannedCostNum.toFixed(6)} USDC</b>
                  </div>
                  <div className="pl-dcw-wallet-row">
                    <span className="muted">Recommended</span>
                    <b>{recommendedStr} USDC</b>
                  </div>
                </div>

                {/* Deposit to Gateway */}
                <div style={{ marginTop: 12, padding: "12px", background: "var(--card-bg, #1a1a2e)", borderRadius: 6, border: "1px solid var(--border, #333)" }}>
                  <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                    Deposit USDC to x402 Balance
                  </p>
                  <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                    Transfer USDC from your wallet into Circle Gateway for x402 auto-pay.
                    Your wallet needs on-chain USDC first.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type="number"
                      step="0.000001"
                      min="0"
                      placeholder="Amount USDC"
                      value={depositAmount}
                      onChange={(e) => { setDepositAmount(e.target.value); setDepositError(null); }}
                      disabled={isDepositing}
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        borderRadius: 4,
                        border: "1px solid var(--border, #444)",
                        background: "var(--input-bg, #0d0d1a)",
                        color: "inherit",
                        fontSize: 13,
                      }}
                    />
                    <button
                      className="pl-primary-v3"
                      onClick={handleDeposit}
                      disabled={isDepositing || !depositAmount}
                      style={{ whiteSpace: "nowrap", opacity: isDepositing || !depositAmount ? 0.5 : 1 }}
                    >
                      {isDepositing ? "Depositing…" : "Deposit"}
                    </button>
                  </div>
                  {depositError && (
                    <p style={{ color: "var(--error, #ef4444)", fontSize: 11, marginTop: 6 }}>{depositError}</p>
                  )}
                  {recommendedTopUp > 0 && (
                    <button
                      className="pl-eoa-fallback-v3"
                      onClick={() => setDepositAmount(recommendedStr)}
                      disabled={isDepositing}
                      style={{ marginTop: 6, fontSize: 11 }}
                    >
                      Use recommended: {recommendedStr} USDC
                    </button>
                  )}
                </div>

                {/* Wallet address for manual funding */}
                <label className="pl-dcw-label" style={{ marginTop: 12 }}>Send USDC to:</label>
                <div className="pl-dcw-address-box">
                  <code>{wallet.address}</code>
                  <button className="pl-copy-v3" onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</button>
                </div>
                <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Send USDC on <b>Arc Testnet</b> to this address.
                </p>

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
