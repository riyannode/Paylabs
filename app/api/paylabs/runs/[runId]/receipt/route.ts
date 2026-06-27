import { NextRequest, NextResponse } from "next/server";
import { getRunReceiptDetail } from "@/lib/paylabs/visibility/read";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  try {
    const receipt = await getRunReceiptDetail(runId);
    if (!receipt) {
      return NextResponse.json({ ok: false, error: "receipt_not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run_id: runId, receipt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "receipt_read_failed";
    console.error("[receipt-api] read failed:", msg);
    return NextResponse.json({ ok: false, error: "receipt_read_failed" }, { status: 500 });
  }
}
