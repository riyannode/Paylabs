/**
 * POST /api/paylabs/sources/ingest/rsshub
 *
 * Thin wrapper over existing syncRsshub() from lib/rsshub/rsshub-sync.
 * Triggers RSSHub feed ingestion into paylabs_feed_items.
 *
 * Reuses: lib/rsshub/rsshub-sync.ts, lib/rsshub/rsshub-client.ts
 * Does NOT duplicate RSSHub client or sync logic.
 */

import { NextRequest, NextResponse } from "next/server";
import { syncRsshub } from "@/lib/rsshub/rsshub-sync";

export async function POST(req: NextRequest) {
  let routeId: string | undefined;

  try {
    const body = await req.json().catch(() => ({}));
    routeId = body.route_id || undefined;
  } catch {
    // No body or invalid JSON — sync all routes
  }

  try {
    const summary = await syncRsshub(routeId);

    return NextResponse.json({
      ok: summary.errors.length === 0,
      sync_started_at: summary.sync_started_at,
      sync_finished_at: summary.sync_finished_at,
      routes_synced: summary.routes_synced,
      items_seen: summary.items_seen,
      items_upserted: summary.items_upserted,
      monetized_items: summary.monetized_items,
      unmonetized_items: summary.unmonetized_items,
      errors: summary.errors,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Ingest failed: ${msg}` },
      { status: 500 }
    );
  }
}
