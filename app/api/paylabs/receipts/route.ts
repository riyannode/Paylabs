import { NextRequest, NextResponse } from "next/server";
import { getRecentReceiptList } from "@/lib/paylabs/visibility/read";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") || 25);

  try {
    const receipts = await getRecentReceiptList(Number.isFinite(limit) ? limit : 25);
    return NextResponse.json({ ok: true, receipts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "receipts_read_failed";
    console.error("[receipts-api] list failed:", msg);
    return NextResponse.json({ ok: false, error: "receipts_read_failed" }, { status: 500 });
  }
}
