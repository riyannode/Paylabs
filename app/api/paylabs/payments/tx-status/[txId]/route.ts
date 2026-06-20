// GET /api/paylabs/payments/tx-status/[txId]
//
// Poll DCW transaction status (for deposit/transfer confirmation).

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ txId: string }> }
) {
  const { txId } = await params;

  if (!txId) {
    return NextResponse.json({ ok: false, error: "txId required" }, { status: 400 });
  }

  try {
    const client = getClient();
    const response = await client.getTransaction({ id: txId });
    const tx = response.data?.transaction;

    if (!tx) {
      return NextResponse.json({ ok: false, error: `Transaction ${txId} not found` }, { status: 404 });
    }

    return NextResponse.json({
      id: tx.id,
      state: tx.state || "UNKNOWN",
      txHash: tx.txHash || undefined,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
