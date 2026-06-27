"use client";

import { useMemo, useState, useEffect, useCallback } from "react";

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
  /** Wallet token balance (on-chain USDC). For DCW, this may be null if not fetched. */
  walletUsdc: string | null;
  /** Gateway balance (deposited USDC available for x402 payments). null if gateway check failed. */
  gatewayUsdc: string | null;
  /** Pending batch settlement USDC */
  pendingBatchUsdc?: string;
  /** Gateway check error (null if ok) */
  gatewayError?: string | null;
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
  ucwGooglePreparing?: boolean;
  ucwGoogleReady?: boolean;
  ucwGoogleError?: string | null;
  onPrepareGoogleLogin?: () => void;
  onRetryPrepareGoogleLogin?: () => void;
  autoPrepareGoogleLogin?: boolean;
  showEmailLogin?: boolean;
  /** Show Gateway deposit / x402 run UI. Default true. Set false for creator wallet. */
  showGatewayDeposit?: boolean;
};

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function asDecimal(value?: string | null): number {
  const n = Number(value ?? "0");
  return Number.isFinite(n) ? n : 0;
}

/** Safe USDC → atomic string conversion using BigInt (no float precision issues) */
function usdcToAtomicString(input: string): string {
  const raw = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) {
    throw new Error("Amount must be a positive USDC value with max 6 decimals");
  }
  const [whole, frac = ""] = raw.split(".");
  const atomic = BigInt(whole) * BigInt(1_000_000) + BigInt(frac.padEnd(6, "0"));
  if (atomic <= BigInt(0)) {
    throw new Error("Amount must be greater than 0");
  }
  return atomic.toString();
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
  ucwGooglePreparing = false,
  ucwGoogleReady = false,
  ucwGoogleError,
  onPrepareGoogleLogin,
  onRetryPrepareGoogleLogin,
  autoPrepareGoogleLogin = true,
  showEmailLogin = true,
  showGatewayDeposit = true,
}: Props) {
  const [activeTab, setActiveTab] = useState<"balances" | "topup">("balances");
  const [depositAmount, setDepositAmount] = useState("");
  const [showEmailInput, setShowEmailInput] = useState(defaultShowEmailInput);
  const [emailValue, setEmailValue] = useState("");
  const [depositError, setDepositError] = useState<string | null>(null);

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

  // Force tab back to balances when gateway deposit UI is hidden
  useEffect(() => {
    if (!showGatewayDeposit && activeTab === "topup") {
      setActiveTab("balances");
    }
  }, [showGatewayDeposit, activeTab]);

  const walletUsdc = asDecimal(ucwBalance?.walletUsdc ?? ucwBalance?.gatewayUsdc ?? "0");
  const x402Balance = asDecimal(ucwBalance?.gatewayUsdc);
  const pendingBatch = asDecimal(ucwBalance?.pendingBatchUsdc);
  const plannedCostNum = asDecimal(plannedCost);
  const needsTopUp = x402Balance < plannedCostNum;
  const gatewayReady = isConnected && !needsTopUp;

  // Recommended top-up: max(plannedCost - x402Balance, plannedCost)
  const recommendedTopUp = Math.max(plannedCostNum - x402Balance, plannedCostNum);
  const recommendedStr = recommendedTopUp > 0 ? recommendedTopUp.toFixed(6) : "0.000001";

  const handleDeposit = useCallback(() => {
    setDepositError(null);
    try {
      const amountAtomic = usdcToAtomicString(depositAmount || recommendedStr);
      onDepositGateway(amountAtomic);
    } catch (e: unknown) {
      setDepositError(e instanceof Error ? e.message : "Invalid amount");
    }
  }, [depositAmount, recommendedStr, onDepositGateway]);

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

        {/* ── Login options (not connected) ── */}
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
          </div>
        ) : (
          /* ── Connected: Balances / Top up tabs ── */
          <div className="pl-wallet-content-v3">
            {/* Connected hero */}
            <div className="pl-connected-hero-v3">
              <div className="pl-connected-status-v3">
                <span className="pl-connected-dot-v3">✓</span>
                <span>
                  {!showGatewayDeposit
                    ? "Creator wallet connected"
                    : needsReconnectToSign
                      ? "Wallet found"
                      : "Wallet connected"}
                </span>
              </div>
              {needsReconnectToSign && (
                <button className="pl-primary-v3" onClick={onReconnect} style={{ marginTop: 8 }}>
                  {walletState === "connecting"
                    ? "Preparing creator wallet login..."
                    : ucwGoogleReady && authMethod === "google"
                      ? "Continue Google reconnect"
                      : authMethod
                        ? `Reconnect via ${authMethod} to sign`
                        : "Reconnect to sign"}
                </button>
              )}
              {error && (
                <div className="pl-wallet-error-v3" style={{ marginTop: 8 }}>
                  {error}
                </div>
              )}
            </div>

            {/* Tab bar — hide Top up x402 tab when gateway deposit is off */}
            {showGatewayDeposit && (
              <div className="pl-wallet-tabs-v3">
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
            )}

            {/* Tab 1: Balances */}
            {activeTab === "balances" && (
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

                  {showGatewayDeposit && (
                    <>
                      <InfoRow icon={<GatewayIcon />} label="x402 Balance" value={`${x402Balance.toFixed(6)} USDC`} />
                      <span className="muted" style={{ fontSize: 10, marginLeft: 28 }}>Powered by Circle Gateway</span>

                      {pendingBatch > 0 && (
                        <InfoRow icon={<PieIcon />} label="Pending Batch" value={`${pendingBatch.toFixed(6)} USDC`} />
                      )}

                      <InfoRow icon={<TrendIcon />} label="Planned Cost" value={`${plannedCostNum.toFixed(6)} USDC`} />
                    </>
                  )}
                </div>

                {/* Status + Actions — only when gateway deposit UI is shown */}
                {showGatewayDeposit && (
                  <>
                    <div style={{ padding: "8px 0", fontSize: 13, fontWeight: 600 }}>
                      {needsTopUp ? (
                        <span style={{ color: "var(--warn, #f59e0b)" }}>⚠ Top up needed</span>
                      ) : (
                        <span style={{ color: "var(--success, #22c55e)" }}>✓ Ready to run</span>
                      )}
                    </div>

                    {gatewayReady ? (
                      <>
                        <button
                          className="pl-primary-v3"
                          onClick={onApprove}
                          disabled={walletState === "approving"}
                        >
                          {walletState === "approving" ? "Running…" : "Run with x402"}
                        </button>
                        <button
                          className="pl-eoa-fallback-v3"
                          onClick={() => setActiveTab("topup")}
                          style={{ marginTop: 4 }}
                        >
                          Add more x402 Balance
                        </button>
                      </>
                    ) : (
                      <button
                        className="pl-primary-v3"
                        onClick={() => setActiveTab("topup")}
                      >
                        Top up x402 Balance
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Tab 2: Top up x402 — only when gateway deposit is enabled */}
            {showGatewayDeposit && activeTab === "topup" && (
              <div className="pl-topup-tab">
                <div className="pl-summary-card-v3">
                  {ucwBalance?.walletUsdc != null ? (
                    <InfoRow icon={<CoinsIcon />} label="Wallet USDC" value={`${ucwBalance.walletUsdc} USDC`} />
                  ) : (
                    <InfoRow icon={<CoinsIcon />} label="Wallet USDC" value="not available" />
                  )}
                  <InfoRow icon={<GatewayIcon />} label="x402 Balance" value={`${x402Balance.toFixed(6)} USDC`} />
                  <InfoRow icon={<TrendIcon />} label="Planned Cost" value={`${plannedCostNum.toFixed(6)} USDC`} />
                  <InfoRow icon={<PieIcon />} label="Recommended" value={`${recommendedStr} USDC`} />
                </div>

                {/* Amount input */}
                <label className="pl-dcw-label" style={{ marginTop: 12 }}>Amount (USDC)</label>
                <input
                  className="pl-email-otp-input"
                  type="text"
                  inputMode="decimal"
                  placeholder={recommendedStr}
                  value={depositAmount}
                  onChange={(e) => { setDepositAmount(e.target.value); setDepositError(null); }}
                  onBlur={() => {
                    // Format on blur
                    const raw = depositAmount.trim();
                    if (!raw) return;
                    const n = Number(raw);
                    if (Number.isFinite(n) && n > 0) {
                      setDepositAmount(n.toFixed(6));
                    }
                  }}
                  step={0.000001}
                  min={0.000001}
                />

                {/* Deposit button — UCW only (real deposit) */}
                {walletInfo.walletType === "circle_user_controlled" ? (
                  <button
                    className="pl-primary-v3"
                    onClick={handleDeposit}
                    disabled={!!depositStatus}
                    style={{ marginTop: 8 }}
                  >
                    {depositStatus || "Top up x402 Balance"}
                  </button>
                ) : (
                  /* DCW: honest disabled state — no real deposit endpoint yet */
                  <div style={{ marginTop: 8 }}>
                    <button className="pl-primary-v3" disabled style={{ opacity: 0.5 }}>
                      Top up x402 Balance
                    </button>
                    <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      DCW x402 Balance is required for auto-pay. DCW Gateway top-up is not wired yet in this build. Fund x402 Balance before auto-pay can run.
                    </p>
                  </div>
                )}

                {/* Deposit stepper status */}
                {depositStatus && (
                  <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--info-bg, #eff6ff)", borderRadius: 6, fontSize: 12 }}>
                    {depositStatus}
                  </div>
                )}

                {/* Error */}
                {(depositError || error) && (
                  <div className="pl-wallet-error-v3" style={{ marginTop: 8 }}>
                    {depositError || error}
                  </div>
                )}

                {/* Back to balances */}
                <button
                  className="pl-eoa-fallback-v3"
                  onClick={() => setActiveTab("balances")}
                  style={{ marginTop: 8 }}
                >
                  ← Back to Balances
                </button>
              </div>
            )}
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
