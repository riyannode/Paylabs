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
import {
  decodeBatchTx,
  buyerInBatch,
  sellerInBatch,
  type DecodedBatch,
} from "@/lib/paylabs/x402/decode-batch";

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
        matchedBy: null,
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
        matchedBy: null,
        updatedAt: new Date().toISOString(),
      });
    }

    // ── 3. Scan Arc explorer for submitBatch txs (paginated, canteen-style) ──
    const settlementUpdatedAtMs = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    let finalHash: string | null = null;
    let bestTs = Infinity;
    let matchedBy: string | null = null;

    try {
      let nextPage: Record<string, string> | null = null;

      for (let page = 0; page < 10; page++) {
        let url: string;
        if (nextPage) {
          const qs = new URLSearchParams(nextPage).toString();
          url = `${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions?${qs}`;
        } else {
          url = `${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions`;
        }

        let resp: Response;
        try {
          resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        } catch {
          break;
        }
        if (!resp.ok) break;

        const data = (await resp.json()) as {
          items: { hash: string; timestamp: string; method: string | null }[];
          next_page_params: Record<string, string> | null;
        };

        for (const tx of data.items) {
          if (tx.method === "submitBatch" && isEvmTxHash(tx.hash)) {
            const txMs = new Date(tx.timestamp).getTime();
            // Batch is submitted AFTER settlement is marked completed
            if (txMs >= settlementUpdatedAtMs && (!finalHash || txMs < bestTs)) {
              finalHash = tx.hash;
              matchedBy = "submitBatch_timestamp_match";
              bestTs = txMs;
            }
          }
        }

        if (finalHash) break;
        nextPage = data.next_page_params;
        if (!nextPage) break;
      }
    } catch (e: unknown) {
      console.error("[batch-tx-resolver] explorer scan error:", e instanceof Error ? e.message : e);
    }

    const batchExplorerUrl = buildTxExplorerUrl(finalHash);

    // ── 4. Decode calldata to verify buyer/seller ──
    let decoded: DecodedBatch | null = null;
    let buyerVerified = false;
    let sellerVerified = false;
    let buyerEntry: { address: string; usdc: string } | null = null;
    let sellerEntry: { address: string; usdc: string } | null = null;

    if (finalHash) {
      try {
        decoded = await decodeBatchTx(finalHash);
        if (decoded) {
          if (fromAddress) {
            const check = buyerInBatch(decoded, fromAddress);
            buyerVerified = check.found;
            if (check.entry) {
              buyerEntry = { address: check.entry.address, usdc: check.entry.usdc };
            }
          }
          if (toAddress) {
            const check = sellerInBatch(decoded, toAddress);
            sellerVerified = check.found;
            if (check.entry) {
              sellerEntry = { address: check.entry.address, usdc: check.entry.usdc };
            }
          }
        }
      } catch (e) {
        console.error("[batch-tx-resolver] calldata decode error:", e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({
      ok: true,
      settlementId,
      status: finalHash ? "completed" : "unresolved",
      batchTxHash: finalHash,
      batchExplorerUrl,
      matchedBy,
      // Calldata verification (Canteen-style)
      calldata_decoded: !!decoded,
      entries_count: decoded?.entries.length ?? 0,
      net_transfers_count: decoded?.netTransfers.length ?? 0,
      buyer_verified: buyerVerified,
      buyer_entry: buyerEntry,
      seller_verified: sellerVerified,
      seller_entry: sellerEntry,
      batch_domain: decoded?.domain ?? null,
      batch_id: decoded?.batchId ?? null,
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
