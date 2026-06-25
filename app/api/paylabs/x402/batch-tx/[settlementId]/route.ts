/**
 * GET /api/paylabs/x402/batch-tx/:settlementId
 *
 * Balanced batch resolver: resolves settlement UUID to on-chain submitBatch tx hash.
 * Uses calldata decode + scoring instead of timestamp-only matching.
 *
 * Per Circle docs: Gateway batches net positions. Multiple users may share
 * the same batchTxHash when payments are in the same submitBatch tx.
 *
 * Requires session authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/paylabs/auth/session";
import {
  buildTxExplorerUrl,
  isUuid,
  isEvmTxHash,
} from "@/lib/paylabs/x402/payment-links";

// ─── Config ──────────────────────────────────────────────────

const GATEWAY_API =
  process.env.CIRCLE_GATEWAY_API_URL ||
  "https://gateway-api-testnet.circle.com";

const ARC_EXPLORER =
  process.env.PAYLABS_ARC_TESTNET_EXPLORER_BASE ||
  "https://testnet.arcscan.app";

const GATEWAY_WALLET =
  process.env.ARC_GATEWAY_WALLET_ADDRESS ||
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const ARC_RPC =
  process.env.ARC_TESTNET_RPC_URL ||
  "https://rpc.testnet.arc.network";

// ─── Scoring constants ───────────────────────────────────────

const SCORE_BUYER_DELTA = 100;
const SCORE_SELLER_DELTA = 80;
const SCORE_BOTH_PRESENT = 60;
const SCORE_TIME_30MIN = 50;
const SCORE_TIME_2H = 25;
const SCORE_UNIQUE_CANDIDATE = 20;
const PENALTY_WRONG_TO = -100;
const PENALTY_WRONG_METHOD = -100;

const THIRTY_MIN_MS = 30 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

type Confidence =
  | "decoded_buyer_seller_match"
  | "decoded_buyer_match"
  | "decoded_seller_time_match"
  | "unique_time_window_match"
  | "none";

interface ScoredCandidate {
  txHash: string;
  timestamp: number;
  score: number;
  confidence: Confidence;
  hasBuyerDelta: boolean;
  hasSellerDelta: boolean;
}

// ─── viem imports (lazy) ─────────────────────────────────────

let _viem: typeof import("viem") | null = null;

async function getViem() {
  if (_viem) return _viem;
  try {
    _viem = await import("viem");
  } catch {
    // viem not available
  }
  return _viem;
}

// ─── Calldata decode ─────────────────────────────────────────

const SUBMIT_BATCH_ABI = [
  { name: "submitBatch", type: "function", inputs: [
    { name: "calldataBytes", type: "bytes" },
    { name: "signature", type: "bytes" },
  ], outputs: [] },
] as const;

interface BatchEntry {
  address: string;
  delta: bigint;
}

async function decodeBatchEntries(
  txInput: `0x${string}`,
): Promise<BatchEntry[] | null> {
  const viem = await getViem();
  if (!viem) return null;

  try {
    const decoded = viem.decodeFunctionData({
      abi: SUBMIT_BATCH_ABI as Parameters<typeof viem.decodeFunctionData>[0]["abi"],
      data: txInput,
    });

    if (decoded.functionName !== "submitBatch") return null;

    const calldataHex = (decoded.args[0] as `0x${string}`).slice(2);
    const word = (i: number) => calldataHex.slice(i * 64, (i + 1) * 64);

    // word 0: offset (0xa0), word 1: batchId, word 2: domain, word 3: token, word 4: innerContract, word 5: count
    const countHex = "0x" + word(5);
    const count = Number(viem.hexToBigInt(countHex as `0x${string}`));

    if (count < 0 || count > 10000) return null; // sanity

    const entries: BatchEntry[] = [];
    for (let i = 0; i < count; i++) {
      const rawAddr = "0x" + word(6 + i * 2).slice(24);
      const address = viem.getAddress(rawAddr as `0x${string}`);
      const delta = viem.hexToBigInt(("0x" + word(7 + i * 2)) as `0x${string}`, { signed: true });
      entries.push({ address, delta });
    }
    return entries;
  } catch {
    return null;
  }
}

// ─── Scoring ─────────────────────────────────────────────────

function scoreCandidate(
  entries: BatchEntry[],
  buyerAddress: string,
  sellerAddress: string,
  amountAtomic: bigint,
  txTimestampMs: number,
  settlementUpdatedAtMs: number,
  isOnlyCandidate: boolean,
): ScoredCandidate {
  const buyerLower = buyerAddress.toLowerCase();
  const sellerLower = sellerAddress.toLowerCase();

  let score = 0;
  let hasBuyerDelta = false;
  let hasSellerDelta = false;

  // Check buyer has negative delta covering amount
  const buyerEntry = entries.find(
    (e) => e.address.toLowerCase() === buyerLower && e.delta < BigInt(0),
  );
  if (buyerEntry && (-buyerEntry.delta) >= amountAtomic) {
    score += SCORE_BUYER_DELTA;
    hasBuyerDelta = true;
  }

  // Check seller has positive delta covering amount
  const sellerEntry = entries.find(
    (e) => e.address.toLowerCase() === sellerLower && e.delta > BigInt(0),
  );
  if (sellerEntry && sellerEntry.delta >= amountAtomic) {
    score += SCORE_SELLER_DELTA;
    hasSellerDelta = true;
  }

  // Both present bonus
  if (hasBuyerDelta && hasSellerDelta) {
    score += SCORE_BOTH_PRESENT;
  }

  // Timestamp scoring
  const diffMs = Math.abs(txTimestampMs - settlementUpdatedAtMs);
  if (diffMs <= THIRTY_MIN_MS) {
    score += SCORE_TIME_30MIN;
  } else if (txTimestampMs <= settlementUpdatedAtMs && diffMs <= TWO_HOURS_MS) {
    score += SCORE_TIME_2H;
  }

  // Uniqueness bonus
  if (isOnlyCandidate) {
    score += SCORE_UNIQUE_CANDIDATE;
  }

  // Confidence
  let confidence: Confidence = "none";
  if (hasBuyerDelta && hasSellerDelta) {
    confidence = "decoded_buyer_seller_match";
  } else if (hasBuyerDelta) {
    confidence = "decoded_buyer_match";
  } else if (hasSellerDelta && diffMs <= THIRTY_MIN_MS) {
    confidence = "decoded_seller_time_match";
  } else if (isOnlyCandidate && diffMs <= THIRTY_MIN_MS) {
    confidence = "unique_time_window_match";
  }

  return {
    txHash: "", // filled by caller
    timestamp: txTimestampMs,
    score,
    confidence,
    hasBuyerDelta,
    hasSellerDelta,
  };
}

// ─── Endpoint ────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ settlementId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const { settlementId } = await params;
  if (!settlementId || !isUuid(settlementId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid settlement ID" },
      { status: 400 },
    );
  }

  try {
    // ── 1. Fetch Circle transfer status ──
    const gwResp = await fetch(
      `${GATEWAY_API}/v1/x402/transfers/${encodeURIComponent(settlementId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!gwResp.ok) {
      return NextResponse.json({
        ok: true,
        settlementId,
        status: "gateway_fetch_failed",
        batchTxHash: null,
        batchExplorerUrl: null,
        confidence: "none" as Confidence,
        score: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    const gwData = await gwResp.json();
    const status = typeof gwData?.status === "string" ? gwData.status.toLowerCase() : "unknown";
    const updatedAt = typeof gwData?.updatedAt === "string" ? gwData.updatedAt : null;
    const fromAddress = typeof gwData?.fromAddress === "string" ? gwData.fromAddress : null;
    const toAddress = typeof gwData?.toAddress === "string" ? gwData.toAddress : null;
    const amount = typeof gwData?.amount === "string" ? gwData.amount : null;

    // ── 2. If not completed/confirmed, return no batch link ──
    const completedStatuses = new Set(["completed", "confirmed"]);
    if (!completedStatuses.has(status)) {
      return NextResponse.json({
        ok: true,
        settlementId,
        status,
        batchTxHash: null,
        batchExplorerUrl: null,
        confidence: "none" as Confidence,
        score: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    // ── 3. Scan Arc explorer for submitBatch txs ──
    const explorerResp = await fetch(
      `${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions?filter=to`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!explorerResp.ok) {
      return NextResponse.json({
        ok: true,
        settlementId,
        status,
        batchTxHash: null,
        batchExplorerUrl: null,
        confidence: "none" as Confidence,
        score: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    const { items } = (await explorerResp.json()) as {
      items: { hash: string; timestamp: string; method: string | null }[];
    };

    const settlementUpdatedAtMs = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    const amountAtomic = amount ? BigInt(amount) : BigInt(0);

    // Filter to submitBatch txs only
    const submitBatchTxs = items.filter(
      (t) => t.method === "submitBatch" && isEvmTxHash(t.hash),
    );

    if (submitBatchTxs.length === 0) {
      return NextResponse.json({
        ok: true,
        settlementId,
        status,
        batchTxHash: null,
        batchExplorerUrl: null,
        confidence: "none" as Confidence,
        score: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    // ── 4. Score candidates with calldata decode ──
    let bestCandidate: ScoredCandidate | null = null;
    let secondBest: ScoredCandidate | null = null;

    for (const tx of submitBatchTxs) {
      const txTimestampMs = new Date(tx.timestamp).getTime();

      // Quick penalty check: skip txs way outside 2h window
      const diffMs = Math.abs(txTimestampMs - settlementUpdatedAtMs);
      if (diffMs > TWO_HOURS_MS) continue;

      let entries: BatchEntry[] | null = null;
      if (fromAddress && toAddress && amountAtomic > BigInt(0)) {
        try {
          const fullTxResp = await fetch(
            `${ARC_EXPLORER}/api/v2/transactions/${tx.hash}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (fullTxResp.ok) {
            const fullTx = await fullTxResp.json() as { raw_input?: string };
            if (fullTx?.raw_input && fullTx.raw_input.length > 10) {
              entries = await decodeBatchEntries(fullTx.raw_input as `0x${string}`);
            }
          }
        } catch {
          // decode failed — fall back to timestamp-only scoring
        }
      }

      const isOnly = submitBatchTxs.length === 1;
      let scored: ScoredCandidate;

      if (entries && fromAddress && toAddress && amountAtomic > BigInt(0)) {
        scored = scoreCandidate(
          entries,
          fromAddress,
          toAddress,
          amountAtomic,
          txTimestampMs,
          settlementUpdatedAtMs,
          isOnly,
        );
      } else {
        // Fallback: timestamp-only scoring (no calldata decode)
        scored = {
          txHash: tx.hash,
          timestamp: txTimestampMs,
          score: 0,
          confidence: "none" as Confidence,
          hasBuyerDelta: false,
          hasSellerDelta: false,
        };
        if (diffMs <= THIRTY_MIN_MS) {
          scored.score += SCORE_TIME_30MIN;
          scored.confidence = "unique_time_window_match";
        }
        if (isOnly) {
          scored.score += SCORE_UNIQUE_CANDIDATE;
        }
      }

      scored.txHash = tx.hash;

      if (!bestCandidate || scored.score > bestCandidate.score) {
        secondBest = bestCandidate;
        bestCandidate = scored;
      } else if (!secondBest || scored.score > secondBest.score) {
        secondBest = scored;
      }
    }

    // ── 5. Apply return conditions ──
    let finalHash: string | null = null;
    let confidence: Confidence = "none";
    let score = 0;

    if (bestCandidate) {
      const isUnique = !secondBest || bestCandidate.score > secondBest.score;

      // Condition 1: score >= 100 AND unique top candidate
      if (bestCandidate.score >= SCORE_BUYER_DELTA && isUnique) {
        finalHash = bestCandidate.txHash;
        confidence = bestCandidate.confidence;
        score = bestCandidate.score;
      }
      // Condition 2: score >= 150 even with second candidate
      else if (bestCandidate.score >= 150) {
        finalHash = bestCandidate.txHash;
        confidence = bestCandidate.confidence;
        score = bestCandidate.score;
      }
      // Condition 3: buyer match exists within 2h window
      else if (bestCandidate.hasBuyerDelta) {
        finalHash = bestCandidate.txHash;
        confidence = "decoded_buyer_match";
        score = bestCandidate.score;
      }
    }

    const batchExplorerUrl = buildTxExplorerUrl(finalHash);

    return NextResponse.json({
      ok: true,
      settlementId,
      status: finalHash ? "completed" : "unresolved",
      batchTxHash: finalHash,
      batchExplorerUrl,
      confidence,
      score,
      updatedAt: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[batch-tx-resolver] Error:", msg);
    return NextResponse.json(
      { ok: false, error: "Batch resolver internal error" },
      { status: 500 },
    );
  }
}
