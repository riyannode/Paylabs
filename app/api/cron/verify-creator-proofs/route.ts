/**
 * Vercel Cron: Verify Pending Creator Proofs
 *
 * GET only (Vercel Cron invokes GET requests).
 * Auth: CRON_SECRET via Authorization: Bearer header.
 * Schedule: 0 0 * * * (daily, Hobby-safe)
 *
 * Checks pending/failed claims with proof_nonce present.
 * Does NOT reject normal failures — keeps claim_status="unclaimed".
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyPendingCreatorClaims } from "@/lib/paylabs/creator-distribution/proof-verifier";

export async function GET(req: NextRequest) {
  // Auth: require CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[cron/verify-creator-proofs] CRON_SECRET not configured");
    return NextResponse.json(
      { error: "Cron not configured" },
      { status: 503 },
    );
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Run batch verification
  const result = await verifyPendingCreatorClaims(10);

  return NextResponse.json({
    ok: true,
    ...result,
  });
}
