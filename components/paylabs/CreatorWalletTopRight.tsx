"use client";

import { useState, useCallback } from "react";
import WalletConnectModal from "./WalletConnectModal";
import { useCreatorUcwWallet } from "./useCreatorUcwWallet";

function shortAddr(addr?: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Compact top-right Creator Wallet pill.
 * Shows connected/disconnected status. Click opens WalletConnectModal.
 * Uses UCW hook — not DCW.
 */
export default function CreatorWalletTopRight() {
  const [open, setOpen] = useState(false);
  const {
    walletState,
    walletInfo,
    ucwBalance,
    walletError,
    needsReconnectToSign,
    authMethod,
    defaultShowEmailInput,
    ucwGooglePreparing,
    ucwGoogleReady,
    ucwGoogleError,
    prepareGoogleLogin,
    retryPrepareGoogleLogin,
    connectGoogle,
    connectEmail,
    connectPin,
    reconnect,
    disconnect,
  } = useCreatorUcwWallet();

  const isConnected = !!walletInfo?.address;

  const handleClick = useCallback(() => {
    setOpen(true);
  }, []);

  return (
    <>
      <button
        type="button"
        className={`pl-creator-wallet-pill ${isConnected ? "connected" : ""}`}
        onClick={handleClick}
        title={walletInfo?.address || "Connect Creator Wallet"}
      >
        <span className={`pl-creator-wallet-dot ${isConnected ? "" : "idle"}`} />
        {isConnected ? (
          <>
            <span className="pl-creator-wallet-label">Creator Wallet</span>
            <span className="pl-creator-wallet-address">{shortAddr(walletInfo.address)}</span>
          </>
        ) : (
          <span className="pl-creator-wallet-label">Connect Creator Wallet</span>
        )}
      </button>

      <WalletConnectModal
        open={open}
        onClose={() => setOpen(false)}
        walletState={walletState}
        walletInfo={walletInfo}
        ucwBalance={ucwBalance}
        error={walletError}
        onConnectGoogle={connectGoogle}
        onConnectEmail={connectEmail}
        onConnectPin={connectPin}
        needsReconnectToSign={needsReconnectToSign}
        onReconnect={reconnect}
        authMethod={authMethod ?? undefined}
        defaultShowEmailInput={defaultShowEmailInput}
        ucwGooglePreparing={ucwGooglePreparing}
        ucwGoogleReady={ucwGoogleReady}
        ucwGoogleError={ucwGoogleError}
        onPrepareGoogleLogin={() => { prepareGoogleLogin().catch(() => {}); }}
        onRetryPrepareGoogleLogin={() => { retryPrepareGoogleLogin().catch(() => {}); }}
        autoPrepareGoogleLogin={false}
        showEmailLogin={false}
        onDisconnect={disconnect}
      />
    </>
  );
}
