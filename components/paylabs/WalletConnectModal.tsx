"use client";

import { useEffect, useMemo, useState } from "react";

export type WalletState =
  | "not_connected"
  | "connecting"
  | "connected"
  | "needs_gateway_deposit"
  | "ready_to_approve"
  | "approving"
  | "depositing"
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
  onConnectEmail: (email: string) => void;
  onConnectPin: () => void;
  onDepositGateway: (amountUsdc: number) => void;
  onRefreshBalance?: () => void;
  onApprove: () => void;
  showEoaFallback?: boolean;
  onConnectEoa?: () => void;
  debugLog?: string[];
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asNumber(value?: string | null) {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
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
  onConnectEmail,
  onConnectPin,
  onDepositGateway,
  onRefreshBalance,
  onApprove,
  showEoaFallback = false,
  onConnectEoa,
  debugLog,
}: Props) {
  const isConnected = !!walletInfo?.address;
  const gatewayBalance = asNumber(ucwBalance?.gateway);
  const currentRunCost = asNumber(plannedCost);
  const gatewayReady = isConnected && gatewayBalance >= currentRunCost;
  const isDepositing = walletState === "depositing" || walletState === "approving";

  // Auto-switch to gateway tab when wallet connects
  const [tab, setTab] = useState<"login" | "gateway">("login");
  useEffect(() => {
    if (isConnected && tab === "login") setTab("gateway");
  }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  const [depositAmount, setDepositAmount] = useState("0.02");

  if (!open) return null;

  return (
    <div className="pl-wallet-overlay-v3">
      <div className="pl-wallet-modal-v3">
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="pl-wallet-tabs-v3">
          {!isConnected && (
            <button
              className={tab === "login" ? "active" : ""}
              onClick={() => setTab("login")}
            >
              Login
            </button>
          )}
          <button
            className={tab === "gateway" ? "active" : ""}
            onClick={() => setTab("gateway")}
          >
            {isConnected ? "Wallet" : "Gateway"}
          </button>
        </div>

        {/* ── LOGIN TAB (only when not connected) ── */}
        {tab === "login" && !isConnected && (
          <div className="pl-wallet-content-v3">
            <div className="pl-login-stack-v3">
              <button
                className="pl-login-option-v3"
                onClick={onConnectGoogle}
                disabled={walletState === "connecting"}
              >
                <span className="pl-login-icon-v3 google"><GoogleIcon /></span>
                <b>Social</b>
              </button>

              <button
                className="pl-login-option-v3"
                onClick={() => {
                  const next = window.prompt("Enter email for OTP");
                  if (next) onConnectEmail(next);
                }}
                disabled={walletState === "connecting"}
              >
                <span className="pl-login-icon-v3"><MailIcon /></span>
                <b>Email</b>
              </button>

              <button
                className="pl-login-option-v3"
                onClick={onConnectPin}
                disabled={walletState === "connecting"}
              >
                <span className="pl-login-icon-v3"><LockIcon /></span>
                <b>PIN</b>
              </button>

              {showEoaFallback && onConnectEoa && (
                <button className="pl-eoa-fallback-v3" onClick={onConnectEoa}>
                  Browser wallet
                </button>
              )}
            </div>

            {walletState === "connecting" && (
              <div style={{ textAlign: "center", padding: "12px 0", color: "#888", fontSize: 13 }}>
                Connecting… (you&apos;ll be redirected to Google)
              </div>
            )}
          </div>
        )}

        {/* ── GATEWAY / WALLET TAB ── */}
        {tab === "gateway" && (
          <div className="pl-wallet-content-v3">
            <WalletRunSummary
              walletInfo={walletInfo}
              ucwBalance={ucwBalance}
              budget={budget}
              plannedCost={plannedCost}
              gatewayReady={gatewayReady}
            />

            {/* Not connected — ask to login */}
            {!isConnected && (
              <button className="pl-primary-v3" onClick={() => setTab("login")}>
                Login first
              </button>
            )}

            {/* Connected + needs deposit */}
            {isConnected && !gatewayReady && !isDepositing && (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, marginTop: 8 }}>
                  <label style={{ fontSize: 13, color: "#666", whiteSpace: "nowrap" }}>Amount (USDC)</label>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    style={{ flex: 1, padding: "6px 10px", border: "1px solid #ddd", borderRadius: 6, fontSize: 14 }}
                  />
                </div>
                <button
                  className="pl-primary-v3"
                  onClick={() => onDepositGateway(parseFloat(depositAmount) || 0.02)}
                  disabled={parseFloat(depositAmount) <= 0}
                >
                  Deposit {depositAmount} USDC to Gateway
                </button>
                {onRefreshBalance && (
                  <button
                    className="pl-eoa-fallback-v3"
                    onClick={onRefreshBalance}
                    style={{ marginTop: 6 }}
                  >
                    ↻ Refresh balance
                  </button>
                )}
              </>
            )}

            {/* Connected + depositing in progress */}
            {isConnected && isDepositing && (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <div style={{ fontSize: 14, color: "#555", marginBottom: 8 }}>
                  Depositing to Gateway…
                </div>
                <div style={{ fontSize: 12, color: "#888" }}>
                  Approve the transaction in the popup, then wait for confirmation.
                </div>
                {onRefreshBalance && (
                  <button
                    className="pl-eoa-fallback-v3"
                    onClick={onRefreshBalance}
                    style={{ marginTop: 12 }}
                  >
                    ↻ Refresh balance
                  </button>
                )}
              </div>
            )}

            {/* Connected + gateway ready */}
            {isConnected && gatewayReady && (
              <button className="pl-primary-v3" onClick={onApprove}>
                Run with x402
              </button>
            )}
          </div>
        )}

        {error && <div className="pl-wallet-error-v3">{error}</div>}
        {debugLog && debugLog.length > 0 && (
          <details className="pl-wallet-error-v3" style={{ marginTop: 8, fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
            <summary>Debug Log ({debugLog.length})</summary>
            {debugLog.map((l, i) => <div key={i}>{l}</div>)}
          </details>
        )}
      </div>
    </div>
  );
}

function WalletRunSummary({
  walletInfo,
  ucwBalance,
  budget,
  plannedCost,
  gatewayReady,
}: {
  walletInfo: WalletInfo | null;
  ucwBalance: UcwBalance | null;
  budget: string;
  plannedCost: string;
  gatewayReady: boolean;
}) {
  const isConnected = !!walletInfo?.address;

  return (
    <div className="pl-summary-card-v3">
      <InfoRow
        icon={<WalletIcon />}
        label="Wallet address"
        value={shortAddr(walletInfo?.address)}
        copyValue={walletInfo?.address}
      />

      <InfoRow
        icon={<CoinsIcon />}
        label="Wallet balance"
        value={`${ucwBalance?.usdc ?? "0.00"} USDC`}
      />

      <InfoRow
        icon={<GatewayIcon />}
        label="Gateway balance"
        value={`${ucwBalance?.gateway ?? "0.00"} USDC`}
        danger={isConnected && !gatewayReady}
      />

      <InfoRow icon={<PieIcon />} label="Budget" value={`${budget} USDC`} />
      <InfoRow icon={<TrendIcon />} label="Planned cost" value={`${plannedCost} USDC`} />
    </div>
  );
}

function InfoRow({
  icon,
  label,
  value,
  copyValue,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  copyValue?: string | null;
  danger?: boolean;
}) {
  return (
    <div className="pl-info-row-v3">
      <span className="pl-row-icon-v3">{icon}</span>
      <span className="pl-row-label-v3">{label}</span>
      <b className={danger ? "danger" : ""}>
        {value}
        {copyValue && (
          <button
            type="button"
            className="pl-copy-v3"
            onClick={() => navigator.clipboard?.writeText(copyValue)}
            aria-label="Copy wallet address"
          >
            <CopyIcon />
          </button>
        )}
      </b>
    </div>
  );
}

// ── SVG Icon Components ──

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

function LockIcon() {
  return <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></Svg>;
}

function WalletIcon() {
  return <Svg><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></Svg>;
}

function CoinsIcon() {
  return <Svg><circle cx="9" cy="9" r="7" /><path d="M14.5 14.5 19 19" /><circle cx="15" cy="15" r="5" /></Svg>;
}

function GatewayIcon() {
  return <Svg><path d="M12 2L2 7l10 5 10-5-10-5Z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></Svg>;
}

function PieIcon() {
  return <Svg><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10Z" /></Svg>;
}

function TrendIcon() {
  return <Svg><polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" /></Svg>;
}

function CopyIcon() {
  return <Svg><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Svg>;
}
