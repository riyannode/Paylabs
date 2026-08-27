import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { isUuid } from "@/lib/paylabs/x402/payment-links";
import { resolveSettlementBatch } from "@/lib/paylabs/x402/batch-resolver";

/** Authenticated settlement-specific resolver. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ settlementId: string }> },
) {
  if (!(await getSession())) return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  const { settlementId } = await params;
  if (!settlementId || !isUuid(settlementId)) return NextResponse.json({ ok: false, error: "Invalid settlement ID" }, { status: 400 });

  const result = await resolveSettlementBatch(settlementId);
  return NextResponse.json({
    ok: true,
    settlementId,
    status: result.status,
    batchTxHash: result.batchTxHash,
    batchExplorerUrl: result.batchExplorerUrl,
    matchedBy: result.matchedBy,
    calldata_decoded: result.matchedBy === "legacy_arc_submitBatch_corroborated",
    buyer_verified: result.buyerVerified,
    seller_verified: result.sellerVerified,
    updatedAt: new Date().toISOString(),
  });
}
