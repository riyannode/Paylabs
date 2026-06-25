"use client";

import { useState, useEffect, useCallback } from "react";

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

export default function DcwModal({ open, onClose, onWalletReady, plannedCost = "0.000015" }: Props) {
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
      const resp = await fetch("/api/paylabs/dcw/balance");
      const data = await resp.json();
      if (data.ok) {
        setBalance({
          walletUsdc: data.wallet?.usdc ?? null,
          gatewayUsdc: data.gateway?.balanceUsdc || "0",
          pendingBatchUsdc: data.gateway?.pendingBatchUsdc || "0",
        });
      }
    } catch {}
  }, []);

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

        {/* ── Step: Auth (Passkey) ──────────────────────── */}
        {step === "auth" && (
          <div className="pl-dcw-step">
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
              autoFocus
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
            <div className="pl-auth-divider"><span>or</span></div>
            {!otpSent ? (
              <button
                className="pl-eoa-fallback-v3"
                onClick={handleSendOtp}
                disabled={!email.includes("@") || isSendingOtp}
              >
                {isSendingOtp ? "Sending…" : "📧 Send Code to Email"}
              </button>
            ) : (
              <div className="pl-otp-input-group">
                <input
                  className="pl-email-otp-input"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && otpCode.length === 6) handleVerifyOtp();
                  }}
                  autoFocus
                />
                <button
                  className="pl-primary-v3"
                  onClick={handleVerifyOtp}
                  disabled={otpCode.length !== 6 || isVerifyingOtp}
                >
                  {isVerifyingOtp ? "Verifying…" : "Verify Code"}
                </button>
                <button
                  className="pl-eoa-fallback-v3"
                  onClick={handleSendOtp}
                  disabled={isSendingOtp}
                  style={{ marginTop: 4 }}
                >
                  Resend code
                </button>
              </div>
            )}
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Biometrics or email code. No passwords.
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

                {/* DCW honest state: deposit not wired */}
                <div style={{ marginTop: 12, padding: "12px", background: "var(--warn-bg, #fef3c7)", borderRadius: 6, border: "1px solid var(--warn-border, #f59e0b)" }}>
                  <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    DCW x402 Balance is required for auto-pay.
                  </p>
                  <p className="muted" style={{ fontSize: 11 }}>
                    DCW Gateway top-up is not wired yet in this build. Fund x402 Balance before auto-pay can run.
                  </p>
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
