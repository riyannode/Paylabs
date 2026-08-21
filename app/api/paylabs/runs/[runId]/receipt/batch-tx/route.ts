import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import {
  buildTxExplorerUrl,
  isEvmTxHash,
  safeExplorerUrl,
} from "@/lib/paylabs/x402/payment-links";
import { resolveSettlementBatch } from "@/lib/paylabs/x402/batch-resolver";

/** Public receipt adapter: run -> last settlement -> safe batch metadata. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ ok: false, error: "runId required" }, { status: 400 });
  }

  const { data: receipt, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("last_settlement_id, last_batch_tx_hash, last_batch_explorer_url")
    .eq("discovery_run_id", runId)
    .maybeSingle();
  if (error || !receipt) return NextResponse.json({ ok: false, error: "receipt not found" }, { status: 404 });

  const cachedHash = isEvmTxHash(receipt.last_batch_tx_hash) ? receipt.last_batch_tx_hash : null;
  const cachedUrl = safeExplorerUrl(receipt.last_batch_explorer_url) || buildTxExplorerUrl(cachedHash);
  if (cachedHash && cachedUrl) {
    return NextResponse.json({
      ok: true,
      batch_tx_hash: cachedHash,
      batch_explorer_url: cachedUrl,
      matched_by: null,
    });
  }

  const settlementId = receipt.last_settlement_id;
  if (typeof settlementId !== "string") {
    return NextResponse.json({
      ok: true,
      status: "missing_settlement_id",
      batch_tx_hash: null,
      batch_explorer_url: null,
      matched_by: null,
    });
  }

  const result = await resolveSettlementBatch(settlementId);
  return NextResponse.json({
    ok: true,
    status: result.status,
    batch_tx_hash: result.batchTxHash,
    batch_explorer_url: result.batchExplorerUrl,
    matched_by: result.matchedBy,
    gateway_status: result.gatewayStatus,
  });
}
