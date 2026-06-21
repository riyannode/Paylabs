// GET /api/paylabs/receipts/[receipt_id]
//
// Returns nanopayment receipt detail.
// Read-only — no payment movement.
// Only returns safe fields — no raw x402 headers, signatures, or secrets.

import { NextRequest, NextResponse } from "next/server";
import { getNanopaymentByReceipt } from "@/lib/paylabs/nanopayment-service";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ receipt_id: string }> }
) {
  const { receipt_id } = await params;

  if (!receipt_id) {
    return NextResponse.json(
      { error: "receipt_id required" },
      { status: 400 }
    );
  }

  const row = await getNanopaymentByReceipt(receipt_id);

  if (!row) {
    return NextResponse.json(
      { error: "Receipt not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    receipt_id: row.receipt_id,
    discovery_run_id: row.discovery_run_id,
    agent_name: row.agent_name,
    payer_agent: row.payer_agent,
    payee_agent: row.payee_agent,
    capability: row.capability,
    route_tier: row.route_tier,
    amount_usdc: row.price_usdc.toString(),
    payment_route: row.payment_route,
    payment_kind: row.payment_kind,
    status: row.status,
    created_at: row.created_at,
  });
}
