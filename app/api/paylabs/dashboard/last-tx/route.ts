import { NextResponse } from "next/server";
import { getLastTx } from "@/lib/paylabs/visibility/read";

export async function GET() {
  try {
    const lastTx = await getLastTx();
    return NextResponse.json({
      ok: true,
      last_tx: lastTx,
      note: lastTx ? null : "No tx hash available from settled x402 events yet.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
