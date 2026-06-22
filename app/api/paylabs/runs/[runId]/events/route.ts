import { NextRequest, NextResponse } from "next/server";
import { getRunEvents } from "@/lib/paylabs/visibility/read";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;

  try {
    const events = await getRunEvents(runId);
    return NextResponse.json({ ok: true, run_id: runId, events });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
