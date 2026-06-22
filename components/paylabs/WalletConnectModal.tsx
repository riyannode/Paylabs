"use client";

import { useMemo, useState } from "react";

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
  onConnectEmail: (email: string) => void;
  onConnectPin: () => void;
  onDepositGateway: () => void;
  onApprove: () => void;
  showEoaFallback?: boolean;
  onConnectEoa?: () => void;
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
  onApprove,
  showEoaFallback = false,
  onConnectEoa,
}: Props) {
  const [tab, setTab] = useState<"login" | "gateway">("login");
  const [email, setEmail] = useState("");

  const isConnected = !!walletInfo?.address;
  const gatewayBalance = asNumber(ucwBalance?.gateway);
  const currentRunCost = asNumber(plannedCost);
  const gatewayReady = isConnected && gatewayBalance >= currentRunCost;

  const statusLabel = useMemo(() => {
    if (!isConnected) return "Not connected";
    if (walletState === "needs_gateway_deposit") return "Deposit needed";
    if (walletState === "approving") return "Approving";
    if (walletState === "paid") return "Paid";
    if (gatewayReady) return "Ready";
    return "Connected";
  }, [isConnected, walletState, gatewayReady]);

  if (!open) return null;

  return (
    <div className="pl-wallet-overlay-v3">
      <div className="pl-wallet-modal-v3">
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="pl-wallet-tabs-v3">
          <button
            className={tab === "login" ? "active" : ""}
            onClick={() => setTab("login")}
          >
            Login
          </button>
          <button
            className={tab === "gateway" ? "active" : ""}
            onClick={() => setTab("gateway")}
          >
            Gateway
          </button>
        </div>

        {tab === "login" && (
          <div className="pl-wallet-content-v3">
            <div className="pl-login-stack-v3">
              <button
                className="pl-login-option-v3"
                onClick={onConnectGoogle}
                disabled={walletState === "connecting"}
              >
                <span className="pl-login-icon-v3 google">G</span>
                <b>Social</b>
              </button>

              <div className="pl-login-option-v3 pl-email-option-v3">
                <span className="pl-login-icon-v3">✉</span>
                <input
                  value={email}
                  type="email"
                  placeholder="Email"
                  onChange={(e) => setEmail(e.target.value)}
                />
                <button
                  onClick={() => onConnectEmail(email)}
                  disabled={!email || walletState === "connecting"}
                >
                  Go
                </button>
              </div>

              <button
                className="pl-login-option-v3"
                onClick={onConnectPin}
                disabled={walletState === "connecting"}
              >
                <span className="pl-login-icon-v3">▣</span>
                <b>PIN</b>
              </button>

              {showEoaFallback && onConnectEoa && (
                <button className="pl-eoa-fallback-v3" onClick={onConnectEoa}>
                  Browser wallet
                </button>
              )}
            </div>

            <WalletRunSummary
              statusLabel={statusLabel}
              walletInfo={walletInfo}
              ucwBalance={ucwBalance}
              budget={budget}
              plannedCost={plannedCost}
              gatewayReady={gatewayReady}
            />

            <button
              className="pl-primary-v3"
              onClick={() => {
                if (!isConnected) return;
                setTab("gateway");
              }}
              disabled={!isConnected}
            >
              Continue
            </button>
          </div>
        )}

        {tab === "gateway" && (
          <div className="pl-wallet-content-v3">
            <WalletRunSummary
              statusLabel={statusLabel}
              walletInfo={walletInfo}
              ucwBalance={ucwBalance}
              budget={budget}
              plannedCost={plannedCost}
              gatewayReady={gatewayReady}
            />

            {!isConnected && (
              <button className="pl-primary-v3" onClick={() => setTab("login")}>
                Login first
              </button>
            )}

            {isConnected && !gatewayReady && (
              <button className="pl-primary-v3" onClick={onDepositGateway}>
                Deposit to Gateway
              </button>
            )}

            {isConnected && gatewayReady && (
              <button className="pl-primary-v3" onClick={onApprove}>
                Run with x402
              </button>
            )}
          </div>
        )}

        {error && <div className="pl-wallet-error-v3">{error}</div>}
      </div>
    </div>
  );
}

function WalletRunSummary({
  statusLabel,
  walletInfo,
  ucwBalance,
  budget,
  plannedCost,
  gatewayReady,
}: {
  statusLabel: string;
  walletInfo: WalletInfo | null;
  ucwBalance: UcwBalance | null;
  budget: string;
  plannedCost: string;
  gatewayReady: boolean;
}) {
  const isConnected = !!walletInfo?.address;

  return (
    <div className="pl-summary-card-v3">
      <div className={`pl-status-chip-v3 ${isConnected ? "ok" : "idle"}`}>
        <span />
        {statusLabel}
      </div>

      <InfoRow
        icon="▣"
        label="Wallet address"
        value={shortAddr(walletInfo?.address)}
        copyValue={walletInfo?.address}
      />

      <InfoRow
        icon="$"
        label="Wallet balance"
        value={`${ucwBalance?.usdc ?? "0.00"} USDC`}
      />

      <InfoRow
        icon="⌁"
        label="Gateway balance"
        value={`${ucwBalance?.gateway ?? "0.00"} USDC`}
        danger={isConnected && !gatewayReady}
      />

      <InfoRow icon="◔" label="Max budget" value={`${budget} USDC`} />

      <InfoRow icon="↗" label="This run cost" value={`${plannedCost} USDC`} />
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
  icon: string;
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
            ⧉
          </button>
        )}
      </b>
    </div>
  );
}
