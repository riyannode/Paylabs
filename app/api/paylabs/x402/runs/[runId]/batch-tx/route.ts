import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { buildTxExplorerUrl, safeExplorerUrl } from "@/lib/paylabs/x402/payment-links";
import { resolveSettlementBatch } from "@/lib/paylabs/x402/batch-resolver";

/** Entry-payment adapter. Service payments must use their own settlement UUID. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId || typeof runId !== "string") return NextResponse.json({ ok: false, error: "runId required" }, { status: 400 });

  const { data: run, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("id, entry_payment_settlement_id, entry_payment_tx_hash, entry_payment_explorer_url, agent_trace, entry_payment_batch_tx_hash, entry_payment_batch_explorer_url")
    .eq("id", runId)
    .single();
  if (error || !run) return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });

  const trace = run.agent_trace && typeof run.agent_trace === "object" ? run.agent_trace as Record<string, unknown> : {};
  const entryTrace = trace.entry_payment && typeof trace.entry_payment === "object" ? trace.entry_payment as Record<string, unknown> : {};
  const settlementId = run.entry_payment_settlement_id || (entryTrace.settlement_id as string | null) || null;
  const directTxHash = run.entry_payment_tx_hash || (entryTrace.tx_hash as string | null) || null;
  const directExplorerUrl = safeExplorerUrl(run.entry_payment_explorer_url) || safeExplorerUrl(entryTrace.explorer_url) || buildTxExplorerUrl(directTxHash);

  if (!settlementId) {
    return NextResponse.json({ ok: true, status: "missing_settlement_id", direct_explorer_url: directExplorerUrl, batch_tx_hash: null, batch_explorer_url: null, matched_by: null });
  }

  const result = await resolveSettlementBatch(settlementId);
  if (result.batchTxHash && result.batchExplorerUrl) {
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({ entry_payment_batch_tx_hash: result.batchTxHash, entry_payment_batch_explorer_url: result.batchExplorerUrl })
      .eq("id", runId)
      .eq("entry_payment_settlement_id", settlementId);
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    direct_explorer_url: directExplorerUrl,
    batch_tx_hash: result.batchTxHash,
    batch_explorer_url: result.batchExplorerUrl,
    matched_by: result.matchedBy,
    trace: { has_settlement_id: true, has_direct_tx: !!directTxHash, has_batch_tx: !!result.batchTxHash, gateway_status: result.gatewayStatus },
  });
}
