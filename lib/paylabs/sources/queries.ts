/**
 * PayLabs Tutor Tools
 * Read-only tools for RSSHub/feed queries + privileged tools for backend executor.
 * Trust boundary: privileged tools go through Payment Adapter only.
 *
 * Phase 1: monetization gate — only verified+monetized sources pass.
 */

import { supabaseAdmin } from "@/lib/paylabs/db/server";

// ─── Read-Only Tools ─────────────────────────────────────────────

/**
 * List all active feed items (monetized or not) for discovery lane.
 * Returns safe metadata — no wallet, no prices for unmonetized items.
 */
export async function listActiveFeedItems(routeId?: string) {
  let query = supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, canonical_url, title, summary, author_name, publisher,
       published_at, tags, normalized_sha256, content_sha256, creator_wallet,
       is_monetized, price_per_citation_usdc, price_per_unlock_usdc, is_active,
       rsshub_route:paylabs_rsshub_routes(
         id, rsshub_base_url, route_path, title, description, source_type,
         creator_wallet, is_monetized, default_price_per_citation_usdc, default_price_per_unlock_usdc,
         is_active, verification_status, verification_method, verified_at
       )`
    )
    .eq("is_active", true)
    .order("published_at", { ascending: false });

  if (routeId) {
    query = query.eq("rsshub_route_id", routeId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch active feed items: ${error.message}`);
  return data || [];
}

export async function getFeedItemById(feedItemId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, canonical_url, title, summary, author_name, publisher,
       published_at, tags, normalized_sha256, content_sha256, creator_wallet, claim_status,
       is_monetized, price_per_citation_usdc, price_per_unlock_usdc, is_active,
       rsshub_route:paylabs_rsshub_routes(
         id, rsshub_base_url, route_path, title, description, source_type,
         creator_wallet, is_monetized, default_price_per_citation_usdc, default_price_per_unlock_usdc,
         is_active, verification_status, verification_method, verified_at
       )`
    )
    .eq("id", feedItemId)
    .single();

  if (error) throw new Error(`Feed item not found: ${error.message}`);
  return data;
}
