import { NextRequest, NextResponse } from "next/server";
import { getRecentPayments } from "@/lib/paylabs/visibility/read";
import { getSession } from "@/lib/paylabs/auth/session";

export async function GET(req: NextRequest) {
  // PR #74: Require session for dashboard endpoints
  const session = await getSession();
  if (!session && process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const limit = Number(req.nextUrl.searchParams.get("limit") || 25);

  try {
    const payments = await getRecentPayments(Math.min(Math.max(limit, 1), 100));
    return NextResponse.json({ ok: true, payments });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}