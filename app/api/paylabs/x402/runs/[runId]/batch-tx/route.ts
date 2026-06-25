/**
 * x402 Batch Transaction Resolver
 *
 * Resolves a discovery run's settlement ID to its on-chain batch tx hash
 * by querying Circle Gateway and scanning Arc explorer for submitBatch txs.
 *
 * Safe response only — never exposes raw Gateway response, signed payloads,
 * API keys, or private keys.
 *
 * Usage: GET /api/paylabs/x402/runs/:runId/batch-tx
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  buildTxExplorerUrl,
  safeExplorerUrl,
  isEvmTxHash,
} from "@/lib/paylabs/x402/payment-links";

const GATEWAY_API =
  process.env.CIRCLE_GATEWAY_API_URL ||
  "https://gateway-api-testnet.circle.com";
const ARC_EXPLORER =
  process.env.PAYLABS_ARC_TESTNET_EXPLORER_BASE ||
  "https://testnet.arcscan.app";
const GATEWAY_WALLET =
  process.env.ARC_GATEWAY_WALLET_ADDRESS ||
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const MAX_PAGES = 10;

/**
 * Scan Arc explorer pages for the nearest submitBatch tx.
 * Flow: Gateway marks settlement "completed" FIRST, then Circle's relayer
 * submits the batch on-chain LATER. So we look for the first submitBatch
 * whose timestamp is >= settlement.updatedAt.
 * We paginate up to MAX_PAGES because high-traffic wallets push submitBatch
 * off the first page of recent deposit txs.
 */
async function findNearestSubmitBatch(
  explorerBase: string,
  gatewayWallet: string,
  updatedAtMs: number,
): Promise<string | null> {
  let nextPage: Record<string, string> | null = null;
  let bestHash: string | null = null;
  let bestTimestamp = Infinity;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url: string;
    if (nextPage) {
      const qs = new URLSearchParams(nextPage).toString();
      url = `${explorerBase}/api/v2/addresses/${gatewayWallet}/transactions?${qs}`;
    } else {
      url = `${explorerBase}/api/v2/addresses/${gatewayWallet}/transactions`;
    }

    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      break;
    }
    if (!resp.ok) break;

    const data = await resp.json() as {
      items: { hash: string; timestamp: string; method: string | null }[];
      next_page_params: Record<string, string> | null;
    };

    for (const tx of data.items) {
      if (tx.method === "submitBatch" && isEvmTxHash(tx.hash)) {
        const txMs = new Date(tx.timestamp).getTime();
        // Batch is submitted AFTER settlement is marked completed
        if (txMs >= updatedAtMs && txMs < bestTimestamp) {
          bestHash = tx.hash;
          bestTimestamp = txMs;
        }
      }
    }

    nextPage = data.next_page_params;
    if (!nextPage) break;
  }

  return bestHash;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  if (!runId || typeof runId !== "string") {
    return NextResponse.json(
      { ok: false, error: "runId required" },
      { status: 400 },
    );
  }

  try {
    // ── 1. Look up run ───────────────────────────────────────
    const { data: run, error: runErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select(
        "id, entry_payment_settlement_id, entry_payment_tx_hash, entry_payment_explorer_url, entry_payment_batch_tx_hash, entry_payment_batch_explorer_url, agent_trace",
      )
      .eq("id", runId)
      .single();

    if (runErr || !run) {
      return NextResponse.json(
        { ok: false, error: "run not found" },
        { status: 404 },
      );
    }

    // ── 2. Resolve from agent_trace fallback ─────────────────
    const entryPaymentTrace =
      run.agent_trace && typeof run.agent_trace === "object"
        ? (run.agent_trace as Record<string, any>).entry_payment
        : null;

    const settlementId =
      run.entry_payment_settlement_id ||
      entryPaymentTrace?.settlement_id ||
      null;

    const directTxHash =
      run.entry_payment_tx_hash ||
      entryPaymentTrace?.tx_hash ||
      null;

    const directExplorerUrl =
      safeExplorerUrl(run.entry_payment_explorer_url) ??
      safeExplorerUrl(entryPaymentTrace?.explorer_url) ??
      buildTxExplorerUrl(directTxHash);

    const cachedBatchTxHash =
      run.entry_payment_batch_tx_hash ||
      entryPaymentTrace?.batch_tx_hash ||
      null;

    const cachedBatchExplorerUrl =
      safeExplorerUrl(run.entry_payment_batch_explorer_url) ??
      safeExplorerUrl(entryPaymentTrace?.batch_explorer_url) ??
      buildTxExplorerUrl(cachedBatchTxHash);

    // ── 3. If batch already cached in DB/trace, return immediately ──
    if (cachedBatchTxHash && cachedBatchExplorerUrl) {
      return NextResponse.json({
        ok: true,
        status: "completed",
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: cachedBatchTxHash,
        batch_explorer_url: cachedBatchExplorerUrl,
        matched_by: "db_or_trace_cached",
        trace: {
          has_settlement_id: !!settlementId,
          has_direct_tx: !!directTxHash,
          has_batch_tx: true,
          gateway_status: null,
        },
      });
    }

    // ── 4. If no settlement ID, return missing ───────────────
    if (!settlementId) {
      return NextResponse.json({
        ok: true,
        status: "missing_settlement_id",
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
        matched_by: null,
        trace: {
          has_settlement_id: false,
          has_direct_tx: !!directTxHash,
          has_batch_tx: false,
          gateway_status: null,
        },
      });
    }

    // ── 5. Fetch Gateway transfer status ─────────────────────
    let gatewayStatus: string;
    let gatewayUpdatedAt: string | null = null;
    let gatewayTxHash: string | null = null;

    try {
      const gwResp = await fetch(
        `${GATEWAY_API}/v1/x402/transfers/${encodeURIComponent(settlementId)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!gwResp.ok) {
        console.log("[batch-tx-resolver] gateway fetch failed", {
          status: gwResp.status,
          hasSettlementId: true,
        });
        return NextResponse.json({
          ok: true,
          status: "gateway_fetch_failed",
          direct_explorer_url: directExplorerUrl,
          batch_tx_hash: null,
          batch_explorer_url: null,
          matched_by: null,
          trace: {
            has_settlement_id: true,
            has_direct_tx: !!directTxHash,
            has_batch_tx: false,
            gateway_status: null,
          },
        });
      }

      const gwData = await gwResp.json();
      // Extract only safe fields — never return raw Gateway response
      gatewayStatus =
        typeof gwData?.status === "string" ? gwData.status.toLowerCase() : "unknown";
      gatewayUpdatedAt =
        typeof gwData?.updatedAt === "string" ? gwData.updatedAt : null;
      // Some Gateway responses include txHash directly
      const candidateTx =
        gwData?.transaction?.txHash ?? gwData?.txHash ?? gwData?.transaction;
      if (typeof candidateTx === "string" && isEvmTxHash(candidateTx)) {
        gatewayTxHash = candidateTx;
      }
    } catch (e) {
      console.log("[batch-tx-resolver] gateway fetch error", {
        hasError: true,
        errorType: e instanceof Error ? e.message : "unknown",
      });
      return NextResponse.json({
        ok: true,
        status: "gateway_fetch_error",
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
        matched_by: null,
        trace: {
          has_settlement_id: true,
          has_direct_tx: !!directTxHash,
          has_batch_tx: false,
          gateway_status: null,
        },
      });
    }

    // ── 6. If still pending, return pending ──────────────────
    const pendingStatuses = new Set(["pending", "received", "processing", "queued"]);
    if (pendingStatuses.has(gatewayStatus)) {
      return NextResponse.json({
        ok: true,
        status: gatewayStatus,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
        matched_by: null,
        trace: {
          has_settlement_id: true,
          has_direct_tx: !!directTxHash,
          has_batch_tx: false,
          gateway_status: gatewayStatus,
        },
      });
    }

    // ── 7. Completed — resolve batch tx hash ─────────────────
    const completedStatuses = new Set(["completed", "confirmed", "settled"]);
    if (!completedStatuses.has(gatewayStatus)) {
      return NextResponse.json({
        ok: true,
        status: gatewayStatus,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
        matched_by: null,
        trace: {
          has_settlement_id: true,
          has_direct_tx: !!directTxHash,
          has_batch_tx: false,
          gateway_status: gatewayStatus,
        },
      });
    }

    let batchTxHash: string | null = gatewayTxHash;
    let matchedBy = "gateway_txhash_field";

    // If Gateway didn't expose txHash, scan Arc explorer (paginated)
    if (!batchTxHash) {
      try {
        const updatedAtMs = gatewayUpdatedAt
          ? new Date(gatewayUpdatedAt).getTime()
          : Date.now();
        const found = await findNearestSubmitBatch(
          ARC_EXPLORER,
          GATEWAY_WALLET,
          updatedAtMs,
        );
        if (found) {
          batchTxHash = found;
          matchedBy = "gateway_status_and_submitBatch_timestamp";
        }
      } catch (e) {
        console.log("[batch-tx-resolver] explorer scan error", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    const batchExplorerUrl = buildTxExplorerUrl(batchTxHash);

    // ── 8. Persist to all dashboard-visible tables (fire-and-forget) ──
    if (batchTxHash && batchExplorerUrl) {
      const db = supabaseAdmin();

      // 8a. paylabs_discovery_runs
      try {
        await db
          .from("paylabs_discovery_runs")
          .update({
            entry_payment_batch_tx_hash: batchTxHash,
            entry_payment_batch_explorer_url: batchExplorerUrl,
          })
          .eq("id", runId);
      } catch (e) {
        console.log("[batch-tx-resolver] db persist discovery_runs failed", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }

      // 8b. paylabs_service_payment_events
      try {
        await db
          .from("paylabs_service_payment_events")
          .update({
            batch_tx_hash: batchTxHash,
            batch_explorer_url: batchExplorerUrl,
          })
          .eq("discovery_run_id", runId);
      } catch (e) {
        console.log("[batch-tx-resolver] db persist service_payment_events failed", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }

      // 8c. paylabs_run_events (only rows that have settlement_id)
      try {
        await db
          .from("paylabs_run_events")
          .update({
            batch_tx_hash: batchTxHash,
            batch_explorer_url: batchExplorerUrl,
          })
          .eq("discovery_run_id", runId)
          .not("settlement_id", "is", null);
      } catch (e) {
        console.log("[batch-tx-resolver] db persist run_events failed", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }

      // 8d. paylabs_receipts
      try {
        await db
          .from("paylabs_receipts")
          .update({
            last_batch_tx_hash: batchTxHash,
            last_batch_explorer_url: batchExplorerUrl,
          })
          .eq("discovery_run_id", runId);
      } catch (e) {
        console.log("[batch-tx-resolver] db persist receipts failed", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      status: batchTxHash ? "completed" : "unresolved",
      direct_explorer_url: directExplorerUrl,
      batch_tx_hash: batchTxHash,
      batch_explorer_url: batchExplorerUrl,
      matched_by: batchTxHash ? matchedBy : null,
      trace: {
        has_settlement_id: true,
        has_direct_tx: !!directTxHash,
        has_batch_tx: !!batchTxHash,
        gateway_status: gatewayStatus,
      },
    });
  } catch (e) {
    console.log("[batch-tx-resolver] unexpected error", {
      hasError: true,
      errorType: e instanceof Error ? e.message : "unknown",
    });
    return NextResponse.json(
      { ok: false, error: "internal error" },
      { status: 500 },
    );
  }
}
