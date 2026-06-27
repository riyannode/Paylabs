"use client";

import { useState, useEffect } from "react";

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
  walletUsdc: string | null;
  gatewayUsdc: string | null;
  pendingBatchUsdc?: string;
  gatewayError?: string | null;
  source: "ucw" | "dcw" | "external_eoa";
};

type Props = {
  open: boolean;
  onClose: () => void;
  walletState: WalletState;
  walletInfo: WalletInfo | null;
  ucwBalance: UcwBalance | null;
  error: string | null;
  onConnectGoogle: () => void;
  onConnectEmail: (email: string) => void;
  onConnectPin: () => void;
  showEoaFallback?: boolean;
  onConnectEoa?: () => void;
  needsReconnectToSign?: boolean;
  onReconnect?: () => void;
  authMethod?: string;
  debugLog?: string[];
  defaultShowEmailInput?: boolean;
  ucwGooglePreparing?: boolean;
  ucwGoogleReady?: boolean;
  ucwGoogleError?: string | null;
  onPrepareGoogleLogin?: () => void;
  onRetryPrepareGoogleLogin?: () => void;
  autoPrepareGoogleLogin?: boolean;
  showEmailLogin?: boolean;
  onDisconnect?: () => void;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function walletTypeLabel(wt?: string): string {
  switch (wt) {
    case "circle_user_controlled": return "UCW";
    case "circle_developer_controlled": return "DCW";
    case "external_eoa": return "EOA";
    default: return "—";
  }
}

export default function WalletConnectModal({
  open,
  onClose,
  walletState,
  walletInfo,
  ucwBalance,
  error,
  onConnectGoogle,
  onConnectEmail,
  onConnectPin,
  showEoaFallback = false,
  onConnectEoa,
  needsReconnectToSign = false,
  onReconnect,
  authMethod,
  debugLog,
  defaultShowEmailInput = false,
  ucwGooglePreparing = false,
  ucwGoogleReady = false,
  ucwGoogleError,
  onPrepareGoogleLogin,
  onRetryPrepareGoogleLogin,
  autoPrepareGoogleLogin = true,
  showEmailLogin = true,
  onDisconnect,
}: Props) {
  const [showEmailInput, setShowEmailInput] = useState(defaultShowEmailInput);
  const [emailValue, setEmailValue] = useState("");
  const isConnected = !!walletInfo?.address;

  useEffect(() => {
    if (defaultShowEmailInput && showEmailLogin) {
      setShowEmailInput(true);
    }
  }, [defaultShowEmailInput, showEmailLogin]);

  useEffect(() => {
    if (!autoPrepareGoogleLogin) return;
    if (!open || isConnected || ucwGoogleReady || ucwGooglePreparing || ucwGoogleError) return;
    onPrepareGoogleLogin?.();
  }, [autoPrepareGoogleLogin, open, isConnected, ucwGoogleReady, ucwGooglePreparing, ucwGoogleError, onPrepareGoogleLogin]);

  if (!open) return null;

  return (
    <div
      className={`pl-wallet-overlay-v3 ${isConnected ? "pl-wallet-overlay-popover" : ""}`}
      onClick={onClose}
    >
      <div
        className={`pl-wallet-modal-v3 ${isConnected ? "pl-wallet-modal-popover" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pl-wallet-x-v3" onClick={onClose} aria-label="Close">
          ×
        </button>

        {!isConnected ? (
          <div className="pl-wallet-content-v3">
            <div className="pl-login-stack-v3">
              <button
                className="pl-login-option-v3"
                onClick={ucwGoogleError && onRetryPrepareGoogleLogin ? onRetryPrepareGoogleLogin : onConnectGoogle}
                disabled={walletState === "connecting" || ucwGooglePreparing}
              >
                <span className="pl-login-icon-v3 google"><GoogleIcon /></span>
                <b>
                  {ucwGooglePreparing
                    ? "Preparing Google login..."
                    : ucwGoogleError
                      ? "Retry Google login setup"
                      : "Continue with Google"}
                </b>
              </button>

              {showEmailLogin && (
                <button
                  className="pl-login-option-v3"
                  onClick={() => setShowEmailInput(!showEmailInput)}
                  disabled={walletState === "connecting"}
                >
                  <span className="pl-login-icon-v3"><MailIcon /></span>
                  <b>Email</b>
                </button>
              )}

              {showEmailLogin && showEmailInput && (
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
                    disabled={walletState === "connecting" || !emailValue.includes("@")}>
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
          </div>
        ) : (
          <div className="pl-wallet-content-v3">
            <div className="pl-connected-hero-v3">
              <div className="pl-connected-status-v3">
                <span className="pl-connected-dot-v3">✓</span>
                <span>{needsReconnectToSign ? "Creator Wallet found" : "Creator Wallet connected"}</span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0", textAlign: "center" }}>
                Used for creator profile, source ownership, and monetization identity.
              </p>
              {needsReconnectToSign && (
                <button className="pl-primary-v3" onClick={onReconnect} style={{ marginTop: 8 }}>
                  {walletState === "connecting"
                    ? "Preparing Creator Wallet login..."
                    : ucwGoogleReady && authMethod === "google"
                      ? "Continue Google reconnect"
                      : "Reconnect Creator Wallet"}
                </button>
              )}
              {error && (
                <div className="pl-wallet-error-v3" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
            </div>

            <div className="pl-balance-tab">
              <div className="pl-summary-card-v3">
                <InfoRow icon={<WalletIcon />} label="Wallet" value={shortAddr(walletInfo.address)} copyValue={walletInfo.address} />
                <InfoRow icon={<WalletIcon />} label="Type" value={walletTypeLabel(walletInfo.walletType)} />
                <InfoRow icon={<CoinsIcon />} label="Network" value={walletInfo.network || "Arc Testnet"} />
                {ucwBalance?.walletUsdc != null ? (
                  <InfoRow icon={<CoinsIcon />} label="Wallet USDC" value={`${ucwBalance.walletUsdc} USDC`} />
                ) : (
                  <InfoRow icon={<CoinsIcon />} label="Wallet USDC" value="not available" />
                )}
              </div>

              <button className="pl-primary-v3" onClick={onClose}>
                Close
              </button>
              {onDisconnect && (
                <button
                  type="button"
                  className="pl-eoa-fallback-v3"
                  onClick={onDisconnect}
                  style={{ marginTop: 8 }}
                >
                  Disconnect Creator Wallet
                </button>
              )}
            </div>
          </div>
        )}

        {(error || ucwGoogleError) && !isConnected && <div className="pl-wallet-error-v3">{error || ucwGoogleError}</div>}
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

function CopyIcon() {
  return <Svg><rect x="9" y="9" width="11" height="11" rx="2" /><rect x="4" y="4" width="11" height="11" rx="2" /></Svg>;
}
