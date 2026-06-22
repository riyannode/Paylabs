import { NextResponse } from "next/server";
import { getDashboardSummary } from "@/lib/paylabs/visibility/read";

export async function GET() {
  try {
    const summary = await getDashboardSummary();
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
