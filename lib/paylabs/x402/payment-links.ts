/**
 * PayLabs x402 payment link helpers.
 *
 * Safe metadata only:
 * - explorer tx URLs
 * - settlement UUIDs
 * - backend resolver URLs
 *
 * Never expose raw PAYMENT-SIGNATURE, raw x-payment, raw Gateway response,
 * EIP-712 signed payloads, private keys, or secrets.
 */

const ARC_TESTNET_TX_BASE = "https://testnet.arcscan.app/tx";

const ALLOWED_EXPLORER_HOSTS = new Set([
  "testnet.arcscan.app",
  "arc-testnet.blockscout.com",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isEvmTxHash(value: unknown): value is string {
  return typeof value === "string" && EVM_TX_RE.test(value);
}

/**
 * Build a canonical explorer URL from a tx hash.
 * Returns null if the hash is not a valid EVM tx hash.
 */
export function buildTxExplorerUrl(txHash: unknown): string | null {
  if (!isEvmTxHash(txHash)) return null;
  return `${ARC_TESTNET_TX_BASE}/${txHash}`;
}

/**
 * Build a backend settlement resolver URL.
 * Returns null if the settlement ID is not a valid UUID.
 */
export function buildSettlementUrl(settlementId: unknown): string | null {
  if (!isUuid(settlementId)) return null;
  return `/api/paylabs/x402/settlements/${encodeURIComponent(settlementId)}`;
}

/**
 * Build a backend batch tx resolver URL.
 * Returns null if the settlement ID is not a valid UUID.
 */
export function buildBatchResolverUrl(settlementId: unknown): string | null {
  if (!isUuid(settlementId)) return null;
  return `/api/paylabs/x402/batch-tx/${encodeURIComponent(settlementId)}`;
}

/**
 * Resolve a safe explorer href from either an explicit explorer URL or a tx hash.
 * Validates the explorer URL against an allowlist.
 */
export function hrefFromTx(
  explorerUrl?: string | null,
  txHash?: string | null,
): string | null {
  const safe = safeExplorerUrl(explorerUrl);
  if (safe) return safe;
  if (isEvmTxHash(txHash)) return `${ARC_TESTNET_TX_BASE}/${txHash}`;
  return null;
}

/**
 * Validate an explorer URL against the allowlist.
 * Returns the URL string if valid, null otherwise.
 */
export function safeExplorerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!ALLOWED_EXPLORER_HOSTS.has(url.hostname)) return null;
    if (!url.pathname.includes("/tx/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}
