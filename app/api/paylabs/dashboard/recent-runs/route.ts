import { NextRequest, NextResponse } from "next/server";
import { getRecentRuns } from "@/lib/paylabs/visibility/read";

export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") || 25);

  try {
    const runs = await getRecentRuns(Math.min(Math.max(limit, 1), 100));
    return NextResponse.json({ ok: true, runs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
