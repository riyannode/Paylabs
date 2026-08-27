import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";
import { isUuid } from "@/lib/paylabs/x402/payment-links";
import { resolveSettlementBatch } from "@/lib/paylabs/x402/batch-resolver";

/** Public Explorer wrapper: event id -> settlement UUID -> safe batch metadata. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  if (!eventId || !isUuid(eventId)) return NextResponse.json({ ok: false, error: "Invalid payment event ID" }, { status: 400 });

  const { data: payment, error } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("event_id, settlement_id, tx_hash, explorer_url, batch_tx_hash, batch_explorer_url, status")
    .eq("event_id", eventId)
    .maybeSingle();
  if (error || !payment) return NextResponse.json({ ok: false, error: "Payment event not found" }, { status: 404 });

  if (!payment.settlement_id) {
    return NextResponse.json({ ok: true, status: "missing_settlement_id", batchTxHash: null, batchExplorerUrl: null, matchedBy: null });
  }

  const result = await resolveSettlementBatch(payment.settlement_id);
  return NextResponse.json({
    ok: true,
    status: result.status,
    batchTxHash: result.batchTxHash,
    batchExplorerUrl: result.batchExplorerUrl,
    matchedBy: result.matchedBy,
  });
}
