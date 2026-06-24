"use client";

import { useState } from "react";

/* ── DCW Wallet Modal: deposit address + gateway balance ── */

type Props = {
  open: boolean;
  onClose: () => void;
  walletAddress: string | null;
  gatewayBalance: string;
  onConnectEmail: (email: string) => void;
  onDisconnect: () => void;
  connecting: boolean;
  error: string | null;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" /><rect x="4" y="4" width="11" height="11" rx="2" />
    </svg>
  );
}

export default function DcwModal({
  open,
  onClose,
  walletAddress,
  gatewayBalance,
  onConnectEmail,
  onDisconnect,
  connecting,
  error,
}: Props) {
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const handleCopy = () => {
    if (walletAddress) {
      navigator.clipboard?.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="pl-wallet-overlay-v3" onClick={onClose}>
      <div className="pl-wallet-modal-v3" onClick={(e) => e.stopPropagation()}>
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">×</button>

        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 24 }}>⚡</span>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: "4px 0 0" }}>DCW Auto-Pay</h2>
          <p className="muted" style={{ fontSize: 12 }}>Zero signing · Seamless x402</p>
        </div>

        {!walletAddress ? (
          /* ── Not connected: email login ── */
          <div style={{ display: "grid", gap: 12 }}>
            <input
              className="pl-email-otp-input"
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && email.includes("@")) onConnectEmail(email);
              }}
              autoFocus
            />
            <button
              className="pl-primary-v3"
              onClick={() => { if (email.includes("@")) onConnectEmail(email); }}
              disabled={connecting || !email.includes("@")}
            >
              {connecting ? "Connecting…" : "Create Wallet"}
            </button>
            <p className="muted" style={{ fontSize: 11, textAlign: "center" }}>
              We create a secure wallet for you. No browser extension needed.
            </p>
          </div>
        ) : (
          /* ── Connected: deposit address + balance ── */
          <div style={{ display: "grid", gap: 16 }}>
            <div className="pl-dcw-card">
              <div className="pl-dcw-label">Your Deposit Address</div>
              <div className="pl-dcw-addr">
                <span className="data-mono">{shortAddr(walletAddress)}</span>
                <button className="pl-copy-v3" onClick={handleCopy} aria-label="Copy">
                  {copied ? "✓" : <CopyIcon />}
                </button>
              </div>
              <div className="pl-dcw-hint">Send USDC on Arc to this address</div>
            </div>

            <div className="pl-dcw-card">
              <div className="pl-dcw-label">Gateway Balance</div>
              <div className="pl-dcw-balance">{gatewayBalance} USDC</div>
            </div>

            <button className="pl-primary-v3" onClick={onDisconnect} style={{ background: "transparent", color: "var(--muted, #6b7280)", border: "1px solid var(--border, #e5e7eb)" }}>
              Disconnect
            </button>
          </div>
        )}

        {error && <div className="pl-wallet-error-v3">{error}</div>}
      </div>
    </div>
  );
}
