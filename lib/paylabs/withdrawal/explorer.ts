/**
 * Arc Testnet Explorer URL Generation
 */

const ARC_TESTNET_TX_BASE = "https://testnet.arcscan.app/tx";

/**
 * Generate an Arc Testnet explorer URL for a transaction hash.
 * Returns null if the hash is not a valid EVM transaction hash.
 */
export function explorerUrl(txHash: string | null): string | null {
  if (!txHash) return null;
  // EVM tx hash: 0x + 64 hex chars
  if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return `${ARC_TESTNET_TX_BASE}/${txHash}`;
  }
  return null;
}
