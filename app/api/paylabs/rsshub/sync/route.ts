/**
 * POST /api/paylabs/rsshub/sync — trigger RSSHub sync
 * Requires Bearer token: PAYLABS_RSSHUB_SYNC_SECRET
 */

import { NextRequest, NextResponse } from "next/server";
import { syncRsshub } from "@/lib/rsshub/rsshub-sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization") ?? "";
  const syncSecret = process.env.PAYLABS_RSSHUB_SYNC_SECRET;

  if (!syncSecret) {
    return NextResponse.json(
      { error: "Sync not configured" },
      { status: 503 }
    );
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (token !== syncSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Optional: sync single route
  let routeId: string | undefined;
  try {
    const body = await req.json();
    routeId = body.route_id;
  } catch {
    // No body = sync all
  }

  const summary = await syncRsshub(routeId);

  return NextResponse.json(summary);
}
