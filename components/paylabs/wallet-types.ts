/**
 * Shared Wallet Types
 *
 * Types used by BOTH DCW (Payment Wallet) and UCW (Creator Wallet) UI.
 * Extracted from WalletConnectModal.tsx so chat code does not import
 * from the UCW modal file.
 *
 * Wallet boundary:
 *   UCW = Creator Wallet only (creator identity, source claim, monetization)
 *   DCW = PayLabs Payment Wallet (chat x402, Gateway deposit/balance)
 */

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

/**
 * PayLabs Wallet Balance — shared shape for both UCW and DCW.
 *
 * Use source field to distinguish:
 *   "ucw"           = Creator Wallet (UCW) balance
 *   "dcw"           = PayLabs Payment Wallet (DCW) balance
 *   "external_eoa"  = External EOA balance
 */
export type PayLabsWalletBalance = {
  walletUsdc: string | null;
  gatewayUsdc: string | null;
  pendingBatchUsdc?: string;
  gatewayError?: string | null;
  source: "ucw" | "dcw" | "external_eoa";
};

