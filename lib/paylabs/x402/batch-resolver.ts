import { supabaseAdmin } from "@/lib/paylabs/db/server";
import {
  buildTxExplorerUrl,
  isEvmTxHash,
  isUuid,
} from "./payment-links";
import { decodeBatchTx, buyerInBatch, sellerInBatch, type BatchEntry } from "./decode-batch";
import { usdcDecimalToAtomic } from "./usdc";

const GATEWAY_API = process.env.CIRCLE_GATEWAY_API_URL || "https://gateway-api-testnet.circle.com";
const ARC_EXPLORER = process.env.PAYLABS_ARC_TESTNET_EXPLORER_BASE || "https://testnet.arcscan.app";
const GATEWAY_WALLET = process.env.ARC_GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const EXPECTED_DOMAIN = 26;
const EXPECTED_USDC = (process.env.PAYLABS_USDC_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000").toLowerCase();
const MAX_PAGES = 10;

/**
 * Circle's transfer authorization validity is bounded. Keep the legacy scan
 * bounded even when an older transfer response has no createdAt field.
 */
const LEGACY_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_ELIGIBLE_STATUSES = new Set(["confirmed", "completed"]);

type GatewayTransfer = {
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  txHash: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  amount: string | null;
  token: string | null;
};

export type BatchResolution = {
  ok: true;
  settlementId: string;
  status: string;
  batchTxHash: string | null;
  batchExplorerUrl: string | null;
  matchedBy: "circle_official_txhash" | "legacy_arc_submitBatch_corroborated" | null;
  gatewayStatus: string;
  buyerVerified: boolean;
  sellerVerified: boolean;
};

function safeGatewayTransfer(data: unknown): GatewayTransfer {
  const row = data as Record<string, unknown> | null;
  return {
    status: typeof row?.status === "string" ? row.status.toLowerCase() : "unknown",
    createdAt: typeof row?.createdAt === "string" ? row.createdAt : null,
    updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : null,
    txHash: isEvmTxHash(row?.txHash) ? row.txHash : null,
    fromAddress: typeof row?.fromAddress === "string" ? row.fromAddress : null,
    toAddress: typeof row?.toAddress === "string" ? row.toAddress : null,
    amount: typeof row?.amount === "string" ? row.amount : null,
    token: typeof row?.token === "string" ? row.token : null,
  };
}

async function fetchTransfer(settlementId: string): Promise<GatewayTransfer | null> {
  try {
    const response = await fetch(`${GATEWAY_API}/v1/x402/transfers/${encodeURIComponent(settlementId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return safeGatewayTransfer(await response.json());
  } catch {
    return null;
  }
}

type ExplorerTx = { hash: string; timestamp: string; method: string | null };

export type CorroboratedLegacyCandidate = {
  hash: string;
  buyerEntry: BatchEntry;
  sellerEntry: BatchEntry;
};

export function chooseBatchResolution(officialHash: string | null, legacyHash: string | null): {
  hash: string | null;
  matchedBy: BatchResolution["matchedBy"];
} {
  if (officialHash) return { hash: officialHash, matchedBy: "circle_official_txhash" };
  if (legacyHash) return { hash: legacyHash, matchedBy: "legacy_arc_submitBatch_corroborated" };
  return { hash: null, matchedBy: null };
}

export function legacyCandidateHasEvidence(input: {
  decoded: { domain: number; token: string } | null;
  expectedToken: string;
  buyerVerified: boolean;
  sellerVerified: boolean;
}): boolean {
  return !!input.decoded
    && input.decoded.domain === EXPECTED_DOMAIN
    && input.decoded.token.toLowerCase() === input.expectedToken.toLowerCase()
    && input.buyerVerified
    && input.sellerVerified;
}

function parseTimestamp(value: string | null): number {
  if (!value) return Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

/**
 * A confirmed transfer is already confirmed onchain and a completed transfer
 * is fully complete. Therefore a legacy submitBatch must not be in the future
 * relative to updatedAt. The lower bound is the transfer creation time when
 * available, capped by a finite lookback for older records.
 */
export function isLegacyBatchTimestampInWindow(
  txTimestamp: string,
  transfer: Pick<GatewayTransfer, "createdAt" | "updatedAt" | "status">,
): boolean {
  if (!FALLBACK_ELIGIBLE_STATUSES.has(transfer.status)) return false;
  const txMs = parseTimestamp(txTimestamp);
  const updatedAtMs = parseTimestamp(transfer.updatedAt);
  if (!Number.isFinite(txMs) || !Number.isFinite(updatedAtMs)) return false;

  const createdAtMs = parseTimestamp(transfer.createdAt);
  const boundedStart = updatedAtMs - LEGACY_MAX_LOOKBACK_MS;
  const startMs = Number.isFinite(createdAtMs)
    ? Math.max(createdAtMs, boundedStart)
    : boundedStart;

  return startMs <= updatedAtMs && txMs >= startMs && txMs <= updatedAtMs;
}

async function listSubmitBatches(): Promise<ExplorerTx[]> {
  const result = new Map<string, ExplorerTx>();
  let nextPage: Record<string, string> | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = nextPage ? `?${new URLSearchParams(nextPage).toString()}` : "";
    try {
      const response = await fetch(`${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions${query}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) break;
      const data = await response.json() as { items?: ExplorerTx[]; next_page_params?: Record<string, string> | null };
      for (const tx of data.items ?? []) {
        if (tx.method === "submitBatch" && isEvmTxHash(tx.hash)) result.set(tx.hash, tx);
      }
      nextPage = data.next_page_params ?? null;
      if (!nextPage) break;
    } catch {
      break;
    }
  }
  return [...result.values()];
}

function atomicAmountMatches(expectedAtomic: string | null, actualDecimal: string): boolean {
  if (!expectedAtomic || !/^[0-9]+$/.test(expectedAtomic)) return false;
  try {
    return BigInt(expectedAtomic) === usdcDecimalToAtomic(actualDecimal);
  } catch {
    return false;
  }
}

function amountMatchedEntry(
  entries: BatchEntry[],
  address: string,
  sign: "negative" | "positive",
  expectedAtomic: string | null,
): BatchEntry | null {
  const normalizedAddress = address.toLowerCase();
  return entries.find((entry) => {
    const correctSign = sign === "negative" ? entry.delta < BigInt(0) : entry.delta > BigInt(0);
    return correctSign
      && entry.address.toLowerCase() === normalizedAddress
      && atomicAmountMatches(expectedAtomic, entry.usdc.replace(/^[-+]/, ""));
  }) ?? null;
}

export function chooseUniqueCorroboratedLegacyCandidate(
  candidates: CorroboratedLegacyCandidate[],
): CorroboratedLegacyCandidate | null {
  return candidates.length === 1 ? candidates[0] : null;
}

async function findCorroboratedLegacyBatch(transfer: GatewayTransfer): Promise<CorroboratedLegacyCandidate | null> {
  if (
    !transfer.fromAddress
    || !transfer.toAddress
    || transfer.token?.toUpperCase() !== "USDC"
    || !FALLBACK_ELIGIBLE_STATUSES.has(transfer.status)
  ) return null;

  const candidates: CorroboratedLegacyCandidate[] = [];
  for (const candidate of await listSubmitBatches()) {
    if (!isLegacyBatchTimestampInWindow(candidate.timestamp, transfer)) continue;

    const decoded = await decodeBatchTx(candidate.hash);
    if (
      !legacyCandidateHasEvidence({
        decoded,
        expectedToken: EXPECTED_USDC,
        buyerVerified: !!decoded && buyerInBatch(decoded, transfer.fromAddress).found,
        sellerVerified: !!decoded && sellerInBatch(decoded, transfer.toAddress).found,
      })
      || !decoded
    ) continue;

    const buyerEntry = amountMatchedEntry(decoded.entries, transfer.fromAddress, "negative", transfer.amount);
    const sellerEntry = amountMatchedEntry(decoded.entries, transfer.toAddress, "positive", transfer.amount);
    if (!buyerEntry || !sellerEntry) continue;

    candidates.push({ hash: candidate.hash, buyerEntry, sellerEntry });
  }

  // A legacy hash is proof only when all corroborating evidence identifies one
  // transaction. Never select the first equivalent candidate.
  return chooseUniqueCorroboratedLegacyCandidate(candidates);
}

export async function persistSettlementBatch(settlementId: string, batchTxHash: string): Promise<void> {
  const batchExplorerUrl = buildTxExplorerUrl(batchTxHash);
  if (!batchExplorerUrl) return;
  const db = supabaseAdmin();
  await Promise.all([
    db.from("paylabs_service_payment_events").update({ batch_tx_hash: batchTxHash, batch_explorer_url: batchExplorerUrl }).eq("settlement_id", settlementId),
    db.from("paylabs_run_events").update({ batch_tx_hash: batchTxHash, batch_explorer_url: batchExplorerUrl }).eq("settlement_id", settlementId),
    db.from("paylabs_receipts").update({ last_batch_tx_hash: batchTxHash, last_batch_explorer_url: batchExplorerUrl }).eq("last_settlement_id", settlementId),
  ]);
}

export async function resolveSettlementBatch(
  settlementId: string,
  options: { persist?: boolean } = {},
): Promise<BatchResolution> {
  if (!isUuid(settlementId)) {
    return { ok: true, settlementId, status: "invalid_settlement_id", batchTxHash: null, batchExplorerUrl: null, matchedBy: null, gatewayStatus: "unknown", buyerVerified: false, sellerVerified: false };
  }
  const transfer = await fetchTransfer(settlementId);
  if (!transfer) {
    return { ok: true, settlementId, status: "gateway_fetch_failed", batchTxHash: null, batchExplorerUrl: null, matchedBy: null, gatewayStatus: "unknown", buyerVerified: false, sellerVerified: false };
  }
  // Circle's valid top-level txHash is authoritative. Legacy scanning is only
  // allowed for the documented confirmed/completed lifecycle states.
  if (!transfer.txHash && !FALLBACK_ELIGIBLE_STATUSES.has(transfer.status)) {
    return { ok: true, settlementId, status: transfer.status, batchTxHash: null, batchExplorerUrl: null, matchedBy: null, gatewayStatus: transfer.status, buyerVerified: false, sellerVerified: false };
  }

  let batchTxHash = transfer.txHash;
  let matchedBy: BatchResolution["matchedBy"] = batchTxHash ? "circle_official_txhash" : null;
  let buyerVerified = false;
  let sellerVerified = false;

  if (!batchTxHash) {
    const legacyCandidate = await findCorroboratedLegacyBatch(transfer);
    const selected = chooseBatchResolution(null, legacyCandidate?.hash ?? null);
    batchTxHash = selected.hash;
    matchedBy = selected.matchedBy;
    buyerVerified = !!legacyCandidate;
    sellerVerified = !!legacyCandidate;
  }

  if (batchTxHash && options.persist !== false) await persistSettlementBatch(settlementId, batchTxHash);
  return {
    ok: true,
    settlementId,
    // Preserve Circle's transfer lifecycle status. Proof availability is
    // represented independently by batchTxHash/batchExplorerUrl.
    status: transfer.status,
    batchTxHash,
    batchExplorerUrl: buildTxExplorerUrl(batchTxHash),
    matchedBy,
    gatewayStatus: transfer.status,
    buyerVerified,
    sellerVerified,
  };
}
