"use client";

import { useState, useEffect, useCallback } from "react";

type DcwStep = "auth" | "creating" | "wallet" | "deposit" | "error";

type DcwWalletInfo = {
  walletId: string;
  address: string;
  chain: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onWalletReady?: (wallet: DcwWalletInfo) => void;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function DcwModal({ open, onClose, onWalletReady }: Props) {
  const [step, setStep] = useState<DcwStep>("auth");
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState<DcwWalletInfo | null>(null);
  const [gatewayBalance, setGatewayBalance] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

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
        // Already authenticated — check wallet
        if (data.hasWallet && data.walletAddress) {
          setWallet({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
          setStep("deposit");
          refreshBalance();
          onWalletReady?.({ walletId: "", address: data.walletAddress, chain: "ARC-TESTNET" });
        } else {
          // Authenticated but no wallet — create one
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
      // Step 1: Get challenge
      const challengeResp = await fetch("/api/paylabs/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, step: "challenge" }),
      });
      const challengeData = await challengeResp.json();

      if (!challengeData.ok) {
        // If passkey already exists, try login instead
        if (challengeData.error?.includes("already registered")) {
          await handlePasskeyAuthenticate();
          return;
        }
        setError(challengeData.error || "Failed to start registration");
        setStep("error");
        return;
      }

      // Step 2: Create credential via browser
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

      // Step 3: Verify attestation
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

      // Auth complete — now create wallet
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
      // Step 1: Get challenge
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

      // Step 2: Get assertion via browser
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

      // Step 3: Verify assertion
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

      // Auth complete
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
        setGatewayBalance(data.gateway?.balanceUsdc || "0");
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
            <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              Uses your device biometrics (Face ID, Touch ID, fingerprint). No passwords.
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

        {/* ── Step: Deposit ─────────────────────────────── */}
        {step === "deposit" && wallet && (
          <div className="pl-dcw-step">
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
                <span className="muted">Chain</span>
                <b>{wallet.chain}</b>
              </div>
              <div className="pl-dcw-wallet-row">
                <span className="muted">Gateway Balance</span>
                <b style={{ color: parseFloat(gatewayBalance) > 0 ? "var(--success, #22c55e)" : undefined }}>
                  {gatewayBalance} USDC
                </b>
              </div>
            </div>

            <div className="pl-dcw-deposit-info">
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Deposit USDC to your wallet:</p>
              <div className="pl-dcw-address-box">
                <code>{wallet.address}</code>
                <button className="pl-copy-v3" onClick={handleCopy}>{copied ? "Copied!" : "Copy"}</button>
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                Send USDC on <b>Arc Testnet</b> to this address. Once deposited, payments are automatic.
              </p>
            </div>

            <button className="pl-primary-v3" onClick={refreshBalance} style={{ marginTop: 12 }}>
              Refresh Balance
            </button>
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
