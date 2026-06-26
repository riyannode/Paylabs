"use client";

/**
 * CreatorWalletPanel — UCW wallet panel for Creator Dashboard.
 *
 * Thin wrapper around WalletConnectModal + useCreatorUcwWallet hook.
 * Reuses existing CSS classes. No visual redesign.
 */

import { useState } from "react";
import WalletConnectModal from "@/components/paylabs/WalletConnectModal";
import { useCreatorUcwWallet } from "@/components/paylabs/useCreatorUcwWallet";

export default function CreatorWalletPanel() {
  const [walletOpen, setWalletOpen] = useState(false);
  const [budget] = useState("0.0001");
  const [plannedCost] = useState("0.000036"); // Normal tier default

  const wallet = useCreatorUcwWallet({ plannedCost });

  return (
    <>
      {/* Wallet connect button */}
      <button
        type="button"
        className={`pl-wallet-pill ${wallet.walletInfo?.address ? "connected" : ""}`}
        onClick={() => setWalletOpen(true)}
      >
        {wallet.walletInfo?.address ? (
          <>
            <span className="pl-wallet-dot" />
            <span className="pl-wallet-pill-address">
              {wallet.walletInfo.address.slice(0, 6)}…{wallet.walletInfo.address.slice(-4)}
            </span>
            <span className="pl-wallet-pill-network">Arc</span>
            <span className="pl-wallet-pill-balance">
              x402: {wallet.ucwBalance?.gatewayUsdc ?? "0.00"} USDC
            </span>
          </>
        ) : (
          <>
            <span className="pl-wallet-dot idle" />
            <span>Connect Creator Wallet</span>
          </>
        )}
      </button>

      {/* Reuses existing WalletConnectModal — no design changes */}
      <WalletConnectModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        walletState={wallet.walletState}
        walletInfo={wallet.walletInfo}
        ucwBalance={wallet.ucwBalance}
        budget={budget}
        plannedCost={plannedCost}
        error={wallet.walletError}
        onConnectGoogle={wallet.connectGoogle}
        onConnectEmail={wallet.connectEmail}
        onConnectPin={wallet.connectPin}
        onConnectEoa={wallet.connectEoa}
        onDepositGateway={wallet.depositGateway}
        onApprove={() => { setWalletOpen(false); wallet.onApprove(); }}
        showEoaFallback={wallet.showEoaFallback}
        needsReconnectToSign={wallet.needsReconnectToSign}
        onReconnect={wallet.reconnectByAuth}
        authMethod={wallet.authMethod}
        depositStatus={wallet.depositStatus}
        debugLog={wallet.ucwDebug ? wallet.debugLog : undefined}
        defaultShowEmailInput={wallet.showEmailInputForReconnect}
      />
    </>
  );
}
