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
const SETTLEMENT_WINDOW_MS = 10_000;

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

  const resolverUrl = `/api/paylabs/x402/runs/${encodeURIComponent(runId)}/batch-tx`;

  try {
    // ── 1. Look up run ───────────────────────────────────────
    const { data: run, error: runErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select(
        "id, entry_payment_settlement_id, entry_payment_tx_hash, entry_payment_explorer_url, entry_payment_batch_tx_hash, entry_payment_batch_explorer_url",
      )
      .eq("id", runId)
      .single();

    if (runErr || !run) {
      return NextResponse.json(
        { ok: false, error: "run not found" },
        { status: 404 },
      );
    }

    const directExplorerUrl =
      safeExplorerUrl(run.entry_payment_explorer_url) ??
      buildTxExplorerUrl(run.entry_payment_tx_hash);

    // ── 2. If batch already resolved, return immediately ─────
    if (run.entry_payment_batch_explorer_url && run.entry_payment_batch_tx_hash) {
      return NextResponse.json({
        ok: true,
        status: "completed",
        resolver_url: resolverUrl,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: run.entry_payment_batch_tx_hash,
        batch_explorer_url: safeExplorerUrl(run.entry_payment_batch_explorer_url),
        matched_by: "db_cached",
      });
    }

    // ── 3. If no settlement ID, return missing ───────────────
    if (!run.entry_payment_settlement_id) {
      return NextResponse.json({
        ok: true,
        status: "missing_settlement_id",
        resolver_url: resolverUrl,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
      });
    }

    // ── 4. Fetch Gateway transfer status ─────────────────────
    let gatewayStatus: string;
    let gatewayUpdatedAt: string | null = null;
    let gatewayTxHash: string | null = null;

    try {
      const gwResp = await fetch(
        `${GATEWAY_API}/v1/x402/transfers/${encodeURIComponent(run.entry_payment_settlement_id)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!gwResp.ok) {
        console.log("[batch-tx-resolver] gateway fetch failed", {
          status: gwResp.status,
          hasSettlementId: !!run.entry_payment_settlement_id,
        });
        return NextResponse.json({
          ok: true,
          status: "gateway_fetch_failed",
          resolver_url: resolverUrl,
          direct_explorer_url: directExplorerUrl,
          batch_tx_hash: null,
          batch_explorer_url: null,
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
        resolver_url: resolverUrl,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
      });
    }

    // ── 5. If still pending, return pending ──────────────────
    const pendingStatuses = new Set(["pending", "received", "processing", "queued"]);
    if (pendingStatuses.has(gatewayStatus)) {
      return NextResponse.json({
        ok: true,
        status: gatewayStatus,
        resolver_url: resolverUrl,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
      });
    }

    // ── 6. Completed — resolve batch tx hash ─────────────────
    const completedStatuses = new Set(["completed", "confirmed", "settled"]);
    if (!completedStatuses.has(gatewayStatus)) {
      return NextResponse.json({
        ok: true,
        status: gatewayStatus,
        resolver_url: resolverUrl,
        direct_explorer_url: directExplorerUrl,
        batch_tx_hash: null,
        batch_explorer_url: null,
      });
    }

    let batchTxHash: string | null = gatewayTxHash;
    let matchedBy = "gateway_txhash_field";

    // If Gateway didn't expose txHash, scan Arc explorer
    if (!batchTxHash) {
      try {
        const explorerResp = await fetch(
          `${ARC_EXPLORER}/api/v2/addresses/${GATEWAY_WALLET}/transactions?filter=to`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (explorerResp.ok) {
          const { items } = (await explorerResp.json()) as {
            items: { hash: string; timestamp: string; method: string | null }[];
          };
          const updatedAtMs = gatewayUpdatedAt
            ? new Date(gatewayUpdatedAt).getTime()
            : Date.now();
          // Find nearest submitBatch tx before or around updatedAt
          const candidate = items.find(
            (t) =>
              t.method === "submitBatch" &&
              Math.abs(new Date(t.timestamp).getTime() - updatedAtMs) <
                SETTLEMENT_WINDOW_MS,
          );
          if (candidate?.hash && isEvmTxHash(candidate.hash)) {
            batchTxHash = candidate.hash;
            matchedBy = "gateway_status_and_submitBatch_timestamp";
          }
        }
      } catch (e) {
        console.log("[batch-tx-resolver] explorer scan error", {
          hasError: true,
          errorType: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    const batchExplorerUrl = buildTxExplorerUrl(batchTxHash);

    // ── 7. Persist to all dashboard-visible tables (fire-and-forget) ──
    if (batchTxHash && batchExplorerUrl) {
      const db = supabaseAdmin();

      // 7a. paylabs_discovery_runs
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

      // 7b. paylabs_service_payment_events
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

      // 7c. paylabs_run_events (only rows that have settlement_id)
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

      // 7d. paylabs_receipts
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
      resolver_url: resolverUrl,
      direct_explorer_url: directExplorerUrl,
      batch_tx_hash: batchTxHash,
      batch_explorer_url: batchExplorerUrl,
      matched_by: batchTxHash ? matchedBy : null,
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
