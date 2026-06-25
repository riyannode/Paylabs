"use client";

import { useMemo, useState, useEffect } from "react";

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
  walletType: "external_eoa" | "circle_user_controlled" | "circle_developer_controlled";
  network: string;
};

export type UcwBalance = {
  /** Wallet token balance (on-chain USDC). For DCW, this may be null/0 if not fetched. */
  walletUsdc: string;
  /** Gateway balance (deposited USDC available for x402 payments) */
  gatewayUsdc: string;
  /** Pending batch settlement USDC */
  pendingBatchUsdc?: string;
  /** Which wallet type this balance belongs to */
  source: "ucw" | "dcw" | "external_eoa";
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
  onDepositGateway: (amountAtomic: string) => void;
  onApprove: () => void;
  showEoaFallback?: boolean;
  onConnectEoa?: () => void;
  needsReconnectToSign?: boolean;
  onReconnect?: () => void;
  authMethod?: string;
  depositStatus?: string | null;
  debugLog?: string[];
  defaultShowEmailInput?: boolean;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asNumber(value?: string | null) {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function ConnectedWalletHero() {
  return (
    <div className="pl-connected-hero-v3">
      <div className="pl-connected-status-v3">
        <span className="pl-connected-dot-v3">✓</span>
        <span>Wallet connected</span>
      </div>
    </div>
  );
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
  needsReconnectToSign = false,
  onReconnect,
  authMethod,
  depositStatus,
  debugLog,
  defaultShowEmailInput = false,
}: Props) {
  const [depositAmount, setDepositAmount] = useState("");
  const [showEmailInput, setShowEmailInput] = useState(defaultShowEmailInput);
  const [emailValue, setEmailValue] = useState("");

  useEffect(() => {
    if (defaultShowEmailInput) {
      setShowEmailInput(true);
    }
  }, [defaultShowEmailInput]);

  const isConnected = !!walletInfo?.address;
  const gatewayBalance = asNumber(ucwBalance?.gatewayUsdc);
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

  const showAsConnectedPopover =
    !!walletInfo?.address &&
    (
      walletState === "connected" ||
      walletState === "ready_to_approve" ||
      walletState === "needs_gateway_deposit" ||
      walletState === "paid"
    );

  if (!open) return null;

  return (
    <div
      className={`pl-wallet-overlay-v3 ${showAsConnectedPopover ? "pl-wallet-overlay-popover" : ""}`}
      onClick={onClose}
    >
      <div
        className={`pl-wallet-modal-v3 ${showAsConnectedPopover ? "pl-wallet-modal-popover" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">
          ×
        </button>

        <div className="pl-wallet-tabs-v3">
          <button className="active">Wallet</button>
        </div>

        {(
          <div className="pl-wallet-content-v3">
            {!isConnected ? (
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
                  onClick={() => setShowEmailInput(!showEmailInput)}
                  disabled={walletState === "connecting"}
                >
                  <span className="pl-login-icon-v3"><MailIcon /></span>
                  <b>Email</b>
                </button>

                {showEmailInput && (
                  <div className="pl-email-input-row">
                    <input
                      className="pl-email-otp-input"
                      type="email"
                      placeholder="you@example.com"
                      value={emailValue}
                      onChange={(e) => setEmailValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && emailValue.includes("@")) {
                          onConnectEmail(emailValue);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      className="pl-email-submit-btn"
                      onClick={() => {
                        if (emailValue.includes("@")) onConnectEmail(emailValue);
                      }}
                      disabled={walletState === "connecting" || !emailValue.includes("@")}
                    >
                      Send OTP
                    </button>
                  </div>
                )}

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
            ) : (
              <div className="pl-connected-hero-v3">
                <div className="pl-connected-status-v3">
                  <span className="pl-connected-dot-v3">✓</span>
                  <span>{needsReconnectToSign ? "Wallet found" : "Wallet connected"}</span>
                </div>
                {needsReconnectToSign && (
                  <button className="pl-primary-v3" onClick={onReconnect} style={{ marginTop: 8 }}>
                    {authMethod ? `Reconnect via ${authMethod} to sign` : "Reconnect to sign"}
                  </button>
                )}
              </div>
            )}

            <WalletRunSummary
              walletInfo={walletInfo}
              ucwBalance={ucwBalance}
              budget={budget}
              plannedCost={plannedCost}
              gatewayReady={gatewayReady}
            />

            <button
              className="pl-primary-v3"
              onClick={onApprove}
              disabled={!isConnected}
            >
              {isConnected ? "Run with x402" : "Connect first"}
            </button>
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
        label="Wallet"
        value={shortAddr(walletInfo?.address)}
        copyValue={walletInfo?.address}
      />

      <InfoRow
        icon={<CoinsIcon />}
        label={ucwBalance?.source === "dcw" ? "Gateway Balance" : "Wallet USDC"}
        value={`${ucwBalance?.walletUsdc ?? "0.00"} USDC`}
      />

      {ucwBalance?.source === "dcw" && (
        <InfoRow
          icon={<CoinsIcon />}
          label="Gateway (available)"
          value={`${ucwBalance?.gatewayUsdc ?? "0.00"} USDC`}
        />
      )}

      {ucwBalance?.source === "ucw" && (
        <InfoRow
          icon={<CoinsIcon />}
          label="Gateway Balance"
          value={`${ucwBalance?.gatewayUsdc ?? "0.00"} USDC`}
        />
      )}

      <InfoRow icon={<PieIcon />} label="Budget" value={`${budget} USDC`} />
      <InfoRow icon={<TrendIcon />} label="Cost" value={`${plannedCost} USDC`} />
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
  return <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
}

function WalletIcon() {
  return <Svg><path d="M20 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Z" /><path d="M16 12h5v5h-5a2.5 2.5 0 0 1 0-5Z" /></Svg>;
}

function CoinsIcon() {
  return <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M15 9.5A3 3 0 0 0 12 8a3 3 0 0 0 0 6 3 3 0 0 1 0 6 3 3 0 0 1-3-1.5" /></Svg>;
}

function GatewayIcon() {
  return <Svg><path d="M4 17a8 8 0 0 1 16 0" /><path d="M8 17a4 4 0 0 1 8 0" /><path d="M4 21h16" /><path d="M12 17v4" /></Svg>;
}

function PieIcon() {
  return <Svg><path d="M21 12A9 9 0 1 1 12 3v9Z" /><path d="M12 3a9 9 0 0 1 9 9h-9Z" /></Svg>;
}

function TrendIcon() {
  return <Svg><path d="m4 16 5-5 4 4 7-8" /><path d="M15 7h5v5" /></Svg>;
}

function CopyIcon() {
  return <Svg><rect x="9" y="9" width="11" height="11" rx="2" /><rect x="4" y="4" width="11" height="11" rx="2" /></Svg>;
}
