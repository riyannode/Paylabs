/**
 * GET /api/paylabs/x402/settlements/:settlementId
 *
 * Proxy to Circle Gateway transfer status endpoint.
 * Returns safe fields only — never exposes raw Gateway response.
 *
 * Requires session authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/paylabs/auth/session";
import { isUuid } from "@/lib/paylabs/x402/payment-links";

const GATEWAY_API =
  process.env.CIRCLE_GATEWAY_API_URL ||
  "https://gateway-api-testnet.circle.com";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ settlementId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }

  const { settlementId } = await params;

  if (!settlementId || !isUuid(settlementId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid settlement ID (must be UUID)" },
      { status: 400 },
    );
  }

  try {
    const gwResp = await fetch(
      `${GATEWAY_API}/v1/x402/transfers/${encodeURIComponent(settlementId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!gwResp.ok) {
      return NextResponse.json(
        { ok: false, error: `Gateway returned ${gwResp.status}` },
        { status: 502 },
      );
    }

    const gwData = await gwResp.json();

    // Return safe fields only — never raw Gateway response
    return NextResponse.json({
      ok: true,
      settlementId,
      status: typeof gwData?.status === "string" ? gwData.status : null,
      token: typeof gwData?.token === "string" ? gwData.token : null,
      fromAddress: typeof gwData?.fromAddress === "string" ? gwData.fromAddress : null,
      toAddress: typeof gwData?.toAddress === "string" ? gwData.toAddress : null,
      amount: typeof gwData?.amount === "string" ? gwData.amount : null,
      createdAt: typeof gwData?.createdAt === "string" ? gwData.createdAt : null,
      updatedAt: typeof gwData?.updatedAt === "string" ? gwData.updatedAt : null,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Settlement status fetch failed: ${msg}` },
      { status: 500 },
    );
  }
}
