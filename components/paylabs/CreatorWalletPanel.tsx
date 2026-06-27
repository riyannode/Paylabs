"use client";

import { useState } from "react";
import WalletConnectModal from "./WalletConnectModal";
import { useCreatorUcwWallet } from "./useCreatorUcwWallet";

/**
 * Creator wallet panel — renders WalletConnectModal with Gateway deposit / x402 run UI hidden.
 * Creator UCW is for onboarding and monetization only, not for x402 payments.
 */
export default function CreatorWalletPanel() {
  const [open, setOpen] = useState(false);
  const {
    walletState,
    walletInfo,
    ucwBalance,
    walletError,
    needsReconnectToSign,
    authMethod,
    depositStatus,
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
    depositGateway,
  } = useCreatorUcwWallet();

  return (
    <>
      <button
        className="pl-primary-v3"
        onClick={() => setOpen(true)}
      >
        {walletInfo?.address
          ? `Creator Wallet (${walletInfo.address.slice(0, 6)}…${walletInfo.address.slice(-4)})`
          : "Connect Creator Wallet"}
      </button>

      <WalletConnectModal
        open={open}
        onClose={() => setOpen(false)}
        walletState={walletState}
        walletInfo={walletInfo}
        ucwBalance={ucwBalance}
        budget="0"
        plannedCost="0"
        error={walletError}
        onConnectGoogle={connectGoogle}
        onConnectEmail={connectEmail}
        onConnectPin={connectPin}
        onDepositGateway={depositGateway}
        onApprove={() => setOpen(false)}
        needsReconnectToSign={needsReconnectToSign}
        onReconnect={reconnect}
        authMethod={authMethod ?? undefined}
        depositStatus={depositStatus}
        defaultShowEmailInput={defaultShowEmailInput}
        ucwGooglePreparing={ucwGooglePreparing}
        ucwGoogleReady={ucwGoogleReady}
        ucwGoogleError={ucwGoogleError}
        onPrepareGoogleLogin={() => { prepareGoogleLogin().catch(() => {}); }}
        onRetryPrepareGoogleLogin={() => { retryPrepareGoogleLogin().catch(() => {}); }}
        showEmailLogin={false}
        showGatewayDeposit={false}
      />
    </>
  );
}
