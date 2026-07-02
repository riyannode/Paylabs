"use client";

import type { WalletInfo, PayLabsWalletBalance } from "@/components/paylabs/wallet-types";

type WalletPillProps = {
  walletInfo: WalletInfo | null;
  dcwBalance: PayLabsWalletBalance | null;
  walletCopied: boolean;
  shortAddress: (value?: string | null, chars?: number) => string;
  onOpenWallet: () => void;
  onRefreshBalance: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCopyAddress: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDisconnect: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

export function WalletPill({
  walletInfo,
  dcwBalance,
  walletCopied,
  shortAddress,
  onOpenWallet,
  onRefreshBalance,
  onCopyAddress,
  onDisconnect,
}: WalletPillProps) {
  return (
    <button
      type="button"
      className={`pl-wallet-pill ${walletInfo?.address ? "connected" : ""}`}
      onClick={onOpenWallet}
      title={walletInfo?.address || "Connect Payment Wallet"}
    >
      {walletInfo?.address ? (
        <>
          <span className="pl-wallet-dot" />
          <span className="pl-wallet-pill-address">{shortAddress(walletInfo.address)}</span>
          <span className="pl-wallet-pill-network">Arc</span>
          <span className="pl-wallet-pill-balance">
            x402: {dcwBalance?.gatewayUsdc ?? "0.00"} USDC
          </span>
          {dcwBalance?.walletUsdc && dcwBalance.walletUsdc !== "0" && (
            <span className="pl-wallet-pill-balance" style={{ fontSize: 10, opacity: 0.7, marginLeft: 6 }}>
              wallet: {dcwBalance.walletUsdc}
            </span>
          )}
          {walletInfo?.walletType === "circle_developer_controlled" && (
            <button
              type="button"
              className="pl-wallet-copy-btn"
              onClick={onRefreshBalance}
              aria-label="Refresh balance"
              title="Refresh DCW balance"
            >
              ↻
            </button>
          )}
          <button
            type="button"
            className="pl-wallet-copy-btn"
            onClick={onCopyAddress}
            aria-label="Copy wallet address"
            title="Copy wallet address"
          >
            {walletCopied ? "✓" : "⧉"}
          </button>
          <button
            type="button"
            className="pl-wallet-copy-btn"
            onClick={onDisconnect}
            aria-label="Disconnect wallet"
            title="Disconnect wallet"
            style={{ marginLeft: 2, fontSize: 12 }}
          >
            ✕
          </button>
        </>
      ) : (
        <>
          <span className="pl-wallet-dot idle" />
          <span>Connect Payment Wallet</span>
        </>
      )}
    </button>
  );
}
