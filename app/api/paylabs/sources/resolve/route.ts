/**
 * POST /api/paylabs/sources/resolve
 *
 * Standalone source resolution endpoint.
 * Searches ingested feed items by query and returns ranked source context.
 *
 * Safe fields only — NEVER returns source_payload, raw RSS data,
 * creator_wallet, or pricing fields.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveSourcesByQuery } from "@/lib/paylabs/sources/source-resolver";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const query = String(body.query || "").trim();
  if (!query) {
    return NextResponse.json(
      { ok: false, error: "query is required" },
      { status: 400 }
    );
  }

  const intentType = body.intent_type ? String(body.intent_type) : undefined;
  const trustStatus = body.trust_status ? String(body.trust_status) : undefined;
  const claimStatus = body.claim_status ? String(body.claim_status) : undefined;
  const limit = body.limit ? Math.min(Number(body.limit), 50) : 10;

  const result = await resolveSourcesByQuery(query, {
    intentType,
    trustStatus,
    claimStatus,
    limit,
  });

  return NextResponse.json({
    ok: result.ok,
    ...result.sourceContext,
    error: result.error,
  });
}
