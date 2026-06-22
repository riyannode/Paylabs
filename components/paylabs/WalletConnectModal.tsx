"use client";

import { useState, useCallback } from "react";

export type WalletState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "needs_gateway_deposit"
  | "ready_to_approve"
  | "approving"
  | "paid"
  | "failed";

export type WalletInfo = {
  address: string;
  walletType: "external_eoa" | "circle_user_controlled";
  network: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  walletState: WalletState;
  walletInfo: WalletInfo | null;
  budget: string;
  plannedCost: string;
  error: string | null;
  onConnectEoa: () => void;
  onApprove: () => void;
};

const STATE_LABELS: Record<WalletState, string> = {
  not_connected: "Not connected",
  connecting: "Connecting…",
  connected: "Connected",
  needs_gateway_deposit: "Needs gateway deposit",
  ready_to_approve: "Ready to approve",
  approving: "Approving…",
  paid: "Paid",
  failed: "Failed",
};

const STATE_COLORS: Record<WalletState, string> = {
  not_connected: "var(--muted)",
  connecting: "var(--warning)",
  connected: "var(--success)",
  needs_gateway_deposit: "var(--warning)",
  ready_to_approve: "var(--info)",
  approving: "var(--warning)",
  paid: "var(--success)",
  failed: "var(--danger)",
};

function shortAddr(addr?: string): string {
  if (!addr) return "—";
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function WalletConnectModal({
  open,
  onClose,
  walletState,
  walletInfo,
  budget,
  plannedCost,
  error,
  onConnectEoa,
  onApprove,
}: Props) {
  const [activeTab, setActiveTab] = useState<"social" | "email" | "pin">("social");

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div className="pl-modal-backdrop" onClick={handleBackdrop}>
      <div className="pl-wallet-modal">
        <button className="pl-close" onClick={onClose} aria-label="Close">×</button>

        <div className="pl-modal-header">
          <h2>Connect your wallet</h2>
          <p>Secure. User-controlled.</p>
        </div>

        <div className="pl-wallet-grid">
          {/* Left: auth methods */}
          <div>
            <div className="pl-tabs">
              <button
                className={activeTab === "social" ? "active" : ""}
                onClick={() => setActiveTab("social")}
              >
                Social
              </button>
              <button
                className={activeTab === "email" ? "active" : ""}
                onClick={() => setActiveTab("email")}
              >
                Email
              </button>
              <button
                className={activeTab === "pin" ? "active" : ""}
                onClick={() => setActiveTab("pin")}
              >
                PIN
              </button>
            </div>

            <div className="pl-login-buttons">
              <button disabled title="Coming soon — Circle UCW not yet wired">
                Continue with Google
              </button>
              <button disabled title="Coming soon — Circle UCW not yet wired">
                Continue with Apple
              </button>
              <button disabled title="Coming soon — Circle UCW not yet wired">
                Continue with Email
              </button>
            </div>

            <div className="pl-divider">
              <span>or</span>
            </div>

            <button
              className="pl-eoa-btn"
              onClick={onConnectEoa}
              disabled={walletState !== "not_connected"}
            >
              {walletState === "connecting" ? "Connecting…" : "Connect browser wallet"}
            </button>

            <div className="pl-coming-soon">
              Social / Email / PIN — coming soon with Circle User-Controlled Wallet
            </div>
          </div>

          {/* Right: wallet summary */}
          <div className="pl-wallet-summary">
            <div className="pl-status-row">
              <span
                className="pl-status-dot"
                style={{ background: STATE_COLORS[walletState] }}
              />
              <span className="pl-status-label">{STATE_LABELS[walletState]}</span>
            </div>

            {walletInfo ? (
              <>
                <h3>Your wallet</h3>
                <div className="pl-address data-mono">{shortAddr(walletInfo.address)}</div>
                <dl>
                  <div>
                    <dt>Wallet type</dt>
                    <dd>{walletInfo.walletType === "external_eoa" ? "External EOA" : "Circle UCW"}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>{walletInfo.network}</dd>
                  </div>
                  <div>
                    <dt>Budget</dt>
                    <dd>{budget} USDC</dd>
                  </div>
                  <div>
                    <dt>Planned cost</dt>
                    <dd>{plannedCost} USDC</dd>
                  </div>
                </dl>
              </>
            ) : (
              <div className="pl-wallet-empty">
                <p>No wallet connected</p>
                <dl>
                  <div>
                    <dt>Network</dt>
                    <dd>Arc Testnet</dd>
                  </div>
                  <div>
                    <dt>Budget</dt>
                    <dd>{budget} USDC</dd>
                  </div>
                  <div>
                    <dt>Planned cost</dt>
                    <dd>{plannedCost} USDC</dd>
                  </div>
                </dl>
              </div>
            )}

            {error && (
              <div className="pl-wallet-error">{error}</div>
            )}

            {walletState === "ready_to_approve" && (
              <button className="pl-approve" onClick={onApprove}>
                Approve entry payment
              </button>
            )}

            {walletState === "approving" && (
              <button className="pl-approve" disabled>
                Approving…
              </button>
            )}

            {walletState === "paid" && (
              <div className="pl-paid-badge">Entry payment approved</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
