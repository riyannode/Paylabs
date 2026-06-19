/**
 * GET /api/paylabs/feed-items — list active feed items
 * Pagination: limit (default 50, max 200), offset
 * Sort: published_at desc nulls last, then created_at desc
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const rawLimit = Number(searchParams.get("limit")) || 50;
  const limit = Math.min(Math.max(rawLimit, 1), 200);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);

  const { data, error } = await supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      "id, title, summary, canonical_url, author_name, publisher, published_at, tags, creator_wallet, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, normalized_sha256, is_active"
    )
    .eq("is_active", true)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [], limit, offset });
}
