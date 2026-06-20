// GET /api/paylabs/receipts/[receipt_id]
//
// Returns nanopayment receipt detail.
// Read-only — no payment movement.

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
    payer_agent: row.payer_agent,
    payee_agent: row.payee_agent,
    agent_name: row.agent_name,
    capability: row.capability,
    route_tier: row.route_tier,
    settlement_mode: row.settlement_mode,
    amount_usdc: row.price_usdc.toString(),
    agent_wallet: row.agent_wallet,
    payment_route: row.payment_route,
    payment_kind: row.payment_kind,
    x402_payment_ref: row.x402_payment_ref,
    x402_settlement_ref: row.x402_settlement_ref,
    status: row.status,
    created_at: row.created_at,
  });
}
