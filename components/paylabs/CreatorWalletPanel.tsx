"use client";

import { useCallback, useEffect, useState } from "react";
import WalletConnectModal from "./WalletConnectModal";
import { useCreatorUcwWallet } from "./useCreatorUcwWallet";


async function hasActiveUserTestWalletSession() {
  const resp = await fetch("/api/paylabs/auth/session", { credentials: "include" });
  const data = await resp.json().catch(() => ({}));
  return !!data?.ok && !!data?.authenticated && !!data?.hasWallet && !!data?.walletAddress;
}

/**
 * Creator wallet panel — renders the Creator Wallet onboarding modal.
 * Creator Wallet is for onboarding and monetization identity only.
 */
export default function CreatorWalletPanel() {
  const [open, setOpen] = useState(false);
  const [dcwConflict, setDcwConflict] = useState(false);
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

  const refreshDcwConflict = useCallback(async () => {
    try {
      setDcwConflict(await hasActiveUserTestWalletSession());
    } catch {
      setDcwConflict(false);
    }
  }, []);

  useEffect(() => {
    refreshDcwConflict();
  }, [refreshDcwConflict]);

  const openCreatorWalletModal = useCallback(async () => {
    try {
      const active = await hasActiveUserTestWalletSession();
      setDcwConflict(active);
      if (active) return;
    } catch {
      setDcwConflict(false);
    }

    setOpen(true);
  }, []);

  const switchToCreatorWallet = useCallback(async () => {
    await fetch("/api/paylabs/auth/session", {
      method: "DELETE",
      credentials: "include",
    }).catch(() => {});

    setDcwConflict(false);
    setOpen(true);

    if (!walletInfo?.address) {
      await prepareGoogleLogin().catch(() => {});
    }
  }, [prepareGoogleLogin, walletInfo?.address]);

  return (
    <>
      <button
        className="pl-primary-v3"
        onClick={openCreatorWalletModal}
      >
        {walletInfo?.address
          ? `Creator Wallet (${walletInfo.address.slice(0, 6)}…${walletInfo.address.slice(-4)})`
          : "Connect Creator Wallet"}
      </button>

      {dcwConflict && (
        <div className="pl-wallet-error-v3" style={{ marginTop: 8 }}>
          User Test Wallet is connected.
          <button
            type="button"
            className="pl-primary-v3"
            onClick={switchToCreatorWallet}
            style={{ marginTop: 8 }}
          >
            Switch to Creator Wallet
          </button>
        </div>
      )}

      {walletInfo?.address && (
        <button
          type="button"
          className="pl-eoa-fallback-v3"
          onClick={disconnect}
          style={{ marginTop: 8 }}
        >
          Disconnect Creator Wallet
        </button>
      )}

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
