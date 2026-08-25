import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { isUuid } from "@/lib/paylabs/x402/payment-links";
import { resolveSettlementBatch } from "@/lib/paylabs/x402/batch-resolver";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Persist only the two manual preflight proof fields, preserving the trace. */
async function persistPreflightBatchProof(
  runId: string,
  trace: Record<string, unknown>,
  batchTxHash: string | null,
  batchExplorerUrl: string | null,
): Promise<Error | null> {
  const preflight = isRecord(trace.auto_tier_preflight) ? trace.auto_tier_preflight : {};
  const routingPayment = isRecord(preflight.routing_payment) ? preflight.routing_payment : {};
  const nextTrace: Record<string, unknown> = {
    ...trace,
    auto_tier_preflight: {
      ...preflight,
      routing_payment: {
        ...routingPayment,
        batch_tx_hash: batchTxHash,
        batch_explorer_url: batchExplorerUrl,
      },
    },
  };

  const { error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({ agent_trace: nextTrace })
    .eq("id", runId);
  return error ? new Error(error.message) : null;
}

/** Public preflight adapter: run -> routing settlement -> safe batch metadata. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  if (!runId || typeof runId !== "string") {
    return NextResponse.json({ ok: false, error: "runId required" }, { status: 400 });
  }

  const { data: run, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("agent_trace")
    .eq("id", runId)
    .maybeSingle();
  if (error || !run) return NextResponse.json({ ok: false, error: "run not found" }, { status: 404 });

  const trace = run.agent_trace && typeof run.agent_trace === "object"
    ? run.agent_trace as Record<string, unknown>
    : {};
  const preflight = trace.auto_tier_preflight && typeof trace.auto_tier_preflight === "object"
    ? trace.auto_tier_preflight as Record<string, unknown>
    : {};
  const routingPayment = preflight.routing_payment && typeof preflight.routing_payment === "object"
    ? preflight.routing_payment as Record<string, unknown>
    : {};
  const settlementId = typeof routingPayment.settlement_id === "string"
    ? routingPayment.settlement_id
    : null;

  if (!settlementId || !isUuid(settlementId)) {
    return NextResponse.json({
      ok: true,
      status: "missing_settlement_id",
      batch_tx_hash: null,
      batch_explorer_url: null,
      matched_by: null,
    });
  }

  const result = await resolveSettlementBatch(settlementId, { persist: false });
  const persistError = await persistPreflightBatchProof(
    runId,
    trace,
    result.batchTxHash,
    result.batchExplorerUrl,
  );
  if (persistError) {
    return NextResponse.json({ ok: false, error: "preflight batch proof persistence failed" }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    status: result.status,
    batch_tx_hash: result.batchTxHash,
    batch_explorer_url: result.batchExplorerUrl,
    matched_by: result.matchedBy,
    gateway_status: result.gatewayStatus,
  });
}
