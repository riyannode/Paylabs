import { supabaseAdmin } from "@/lib/paylabs/db/server";
import {
  buildTxExplorerUrl,
  isEvmTxHash,
  isUuid,
} from "./payment-links";
import { decodeBatchTx, buyerInBatch, sellerInBatch } from "./decode-batch";
import { usdcDecimalToAtomic } from "./usdc";

const GATEWAY_API = process.env.CIRCLE_GATEWAY_API_URL || "https://gateway-api-testnet.circle.com";
const ARC_EXPLORER = process.env.PAYLABS_ARC_TESTNET_EXPLORER_BASE || "https://testnet.arcscan.app";
const GATEWAY_WALLET = process.env.ARC_GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const EXPECTED_DOMAIN = 26;
const EXPECTED_USDC = (process.env.PAYLABS_USDC_CONTRACT_ADDRESS || process.env.NEXT_PUBLIC_ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000").toLowerCase();
const MAX_PAGES = 10;

const FALLBACK_ELIGIBLE_STATUSES = new Set(["confirmed", "completed"]);

type GatewayTransfer = {
  status: string;
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

async function listSubmitBatches(): Promise<ExplorerTx[]> {
  const result: ExplorerTx[] = [];
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
        if (tx.method === "submitBatch" && isEvmTxHash(tx.hash)) result.push(tx);
      }
      nextPage = data.next_page_params ?? null;
      if (!nextPage) break;
    } catch {
      break;
    }
  }
  return result;
}

function atomicAmountMatches(expectedAtomic: string | null, actualDecimal: string): boolean {
  if (!expectedAtomic || !/^[0-9]+$/.test(expectedAtomic)) return false;
  try {
    return BigInt(expectedAtomic) === usdcDecimalToAtomic(actualDecimal);
  } catch {
    return false;
  }
}

async function findCorroboratedLegacyBatch(transfer: GatewayTransfer): Promise<string | null> {
  if (!transfer.fromAddress || !transfer.toAddress) return null;
  const completedAt = transfer.updatedAt ? new Date(transfer.updatedAt).getTime() : Number.NaN;
  const candidates = await listSubmitBatches();
  const ordered = candidates
    .filter((tx) => !Number.isNaN(new Date(tx.timestamp).getTime()))
    .filter((tx) => Number.isNaN(completedAt) || new Date(tx.timestamp).getTime() >= completedAt)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const candidate of ordered) {
    const decoded = await decodeBatchTx(candidate.hash);
    if (
      transfer.token?.toUpperCase() !== "USDC"
      || !decoded
      || decoded.domain !== EXPECTED_DOMAIN
      || decoded.token.toLowerCase() !== EXPECTED_USDC
    ) continue;
    const buyer = buyerInBatch(decoded, transfer.fromAddress);
    const seller = sellerInBatch(decoded, transfer.toAddress);
    if (!legacyCandidateHasEvidence({
      decoded,
      expectedToken: EXPECTED_USDC,
      buyerVerified: buyer.found,
      sellerVerified: seller.found,
    }) || !buyer.entry || !seller.entry) continue;
    if (!atomicAmountMatches(transfer.amount, buyer.entry.usdc.replace(/^[-+]/, ""))) continue;
    if (!atomicAmountMatches(transfer.amount, seller.entry.usdc.replace(/^[-+]/, ""))) continue;
    return candidate.hash;
  }
  return null;
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

export async function clearSettlementBatch(settlementId: string): Promise<void> {
  const db = supabaseAdmin();
  await Promise.all([
    db.from("paylabs_service_payment_events").update({ batch_tx_hash: null, batch_explorer_url: null }).eq("settlement_id", settlementId),
    db.from("paylabs_run_events").update({ batch_tx_hash: null, batch_explorer_url: null }).eq("settlement_id", settlementId),
    db.from("paylabs_receipts").update({ last_batch_tx_hash: null, last_batch_explorer_url: null }).eq("last_settlement_id", settlementId),
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
  // Circle's valid top-level txHash is authoritative regardless of whether
  // the transfer has advanced from batched to confirmed/completed yet.
  if (!transfer.txHash && !FALLBACK_ELIGIBLE_STATUSES.has(transfer.status)) {
    return { ok: true, settlementId, status: transfer.status, batchTxHash: null, batchExplorerUrl: null, matchedBy: null, gatewayStatus: transfer.status, buyerVerified: false, sellerVerified: false };
  }

  let batchTxHash = transfer.txHash;
  let matchedBy: BatchResolution["matchedBy"] = batchTxHash ? "circle_official_txhash" : null;
  let buyerVerified = false;
  let sellerVerified = false;

  if (!batchTxHash) {
    const legacyHash = await findCorroboratedLegacyBatch(transfer);
    const selected = chooseBatchResolution(null, legacyHash);
    batchTxHash = selected.hash;
    matchedBy = selected.matchedBy;
    if (batchTxHash) {
      const decoded = await decodeBatchTx(batchTxHash);
      if (decoded && transfer.fromAddress && transfer.toAddress) {
        buyerVerified = buyerInBatch(decoded, transfer.fromAddress).found;
        sellerVerified = sellerInBatch(decoded, transfer.toAddress).found;
      }
    }
  }

  if (batchTxHash && options.persist !== false) await persistSettlementBatch(settlementId, batchTxHash);
  return {
    ok: true,
    settlementId,
    status: batchTxHash ? "completed" : "unresolved",
    batchTxHash,
    batchExplorerUrl: buildTxExplorerUrl(batchTxHash),
    matchedBy,
    gatewayStatus: transfer.status,
    buyerVerified,
    sellerVerified,
  };
}
