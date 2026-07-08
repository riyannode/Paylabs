"use client";

import { useCallback, useEffect, useState } from "react";
import UcwConnectModal from "./UcwConnectModal";
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
  const [finalizingCreatorWallet, setFinalizingCreatorWallet] = useState(false);
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

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hash = window.location.hash;
    const isOAuthReturn =
      hash.includes("access_token") ||
      hash.includes("id_token") ||
      hash.includes("error");

    if (isOAuthReturn) {
      setOpen(true);
      setFinalizingCreatorWallet(true);
    }
  }, []);

  useEffect(() => {
    if (walletInfo?.address) {
      setFinalizingCreatorWallet(false);
      setOpen(false);
    }
  }, [walletInfo?.address]);

  useEffect(() => {
    if (walletError) {
      setFinalizingCreatorWallet(false);
    }
  }, [walletError]);

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
      {walletInfo?.address ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="pl-creator-wallet-dot" />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Connected</span>
            <span style={{ fontSize: 13, color: "#6B6577", fontVariantNumeric: "tabular-nums" }}>
              {walletInfo.address.slice(0, 6)}…{walletInfo.address.slice(-4)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="pl-primary-v3"
              onClick={openCreatorWalletModal}
              style={{ width: "auto", padding: "0 20px" }}
            >
              Manage Wallet
            </button>
            <button
              type="button"
              className="pl-eoa-fallback-v3"
              onClick={disconnect}
              style={{ width: "auto", padding: "0 16px" }}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <button
          className="pl-primary-v3"
          onClick={openCreatorWalletModal}
        >
          Connect Creator Wallet
        </button>
      )}

      {dcwConflict && (
        <div className="pl-wallet-error-v3" style={{ marginTop: 8 }}>
          PayLabs Payment Wallet is connected.
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

      <UcwConnectModal
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
        finalizingCreatorWallet={finalizingCreatorWallet}
      />
    </>
  );
}
