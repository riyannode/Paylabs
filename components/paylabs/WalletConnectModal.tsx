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

export type UcwBalance = {
  usdc: string;
  gateway: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  walletState: WalletState;
  walletInfo: WalletInfo | null;
  ucwBalance: UcwBalance | null;
  budget: string;
  plannedCost: string;
  error: string | null;
  onConnectGoogle: () => void;
  onConnectEoa: () => void;
  onDepositGateway: () => void;
  onApprove: () => void;
  /** Show the hidden EOA fallback button (dev mode only) */
  showEoaFallback?: boolean;
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
  ucwBalance,
  budget,
  plannedCost,
  error,
  onConnectGoogle,
  onConnectEoa,
  onDepositGateway,
  onApprove,
  showEoaFallback = false,
}: Props) {
  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  const isUcw = walletInfo?.walletType === "circle_user_controlled";
  const gatewayBalance = parseFloat(ucwBalance?.gateway ?? "0");
  const planned = parseFloat(plannedCost);
  const canAfford = gatewayBalance >= planned;

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
            {!walletInfo ? (
              <>
                <div className="pl-login-buttons">
                  <button
                    className="pl-social-btn pl-google"
                    onClick={onConnectGoogle}
                    disabled={walletState === "connecting"}
                  >
                    {walletState === "connecting" ? "Connecting…" : "Continue with Google"}
                  </button>
                </div>

                {showEoaFallback && (
                  <>
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
                  </>
                )}
              </>
            ) : (
              <div className="pl-connected-info">
                <div className="pl-auth-badge">
                  {isUcw ? "🔐 Circle UCW" : "🦊 Browser Wallet"}
                </div>
                <div className="pl-address-lg data-mono">{shortAddr(walletInfo.address)}</div>
              </div>
            )}
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

            {walletInfo && (
              <>
                <dl>
                  <div>
                    <dt>Wallet type</dt>
                    <dd>{isUcw ? "Circle UCW" : "External EOA"}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>{walletInfo.network}</dd>
                  </div>
                  {ucwBalance && (
                    <>
                      <div>
                        <dt>USDC balance</dt>
                        <dd>{ucwBalance.usdc} USDC</dd>
                      </div>
                      <div>
                        <dt>Gateway balance</dt>
                        <dd className={canAfford ? "" : "pl-insufficient"}>
                          {ucwBalance.gateway} USDC
                        </dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>Budget</dt>
                    <dd>{budget} USDC</dd>
                  </div>
                  <div>
                    <dt>Planned cost</dt>
                    <dd>{plannedCost} USDC</dd>
                  </div>
                </dl>

                {/* Deposit CTA when Gateway balance < planned cost */}
                {walletState === "needs_gateway_deposit" && !canAfford && (
                  <div className="pl-deposit-cta">
                    <p>Gateway balance insufficient. Deposit USDC to continue.</p>
                    <button className="pl-deposit-btn" onClick={onDepositGateway}>
                      Deposit to Gateway
                    </button>
                  </div>
                )}
              </>
            )}

            {!walletInfo && (
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
