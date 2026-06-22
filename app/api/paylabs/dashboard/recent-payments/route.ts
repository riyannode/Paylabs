import { NextRequest, NextResponse } from "next/server";
import { getRecentPayments } from "@/lib/paylabs/visibility/read";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") || 25);

  try {
    const payments = await getRecentPayments(Math.min(Math.max(limit, 1), 100));
    return NextResponse.json({ ok: true, payments });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
