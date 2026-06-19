/**
 * RSSHub Sync
 *
 * Loads active routes, fetches each, upserts into paylabs_feed_items.
 * Uses creator wallet and prices from route config (not LLM).
 *
 * Monetization gate:
 * - If route is verified AND monetized: feed items inherit wallet + prices
 * - Otherwise: creator_wallet=null, prices=0, is_monetized=false
 *
 * Returns sync summary.
 */

import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { fetchRoute, type NormalizedFeedItem } from "./rsshub-client";

export interface SyncSummary {
  sync_started_at: string;
  sync_finished_at: string;
  routes_synced: number;
  items_seen: number;
  items_upserted: number;
  monetized_items: number;
  unmonetized_items: number;
  errors: string[];
}

interface RsshubRoute {
  id: string;
  rsshub_base_url: string;
  route_path: string;
  title: string;
  creator_wallet: string | null;
  is_monetized: boolean;
  default_price_per_citation_usdc: number;
  default_price_per_unlock_usdc: number;
  verification_status: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function computeNormalizedSha(item: NormalizedFeedItem): string {
  const raw = `${item.canonical_url}|${item.title}|${item.summary}`;
  return sha256(raw);
}

function computeContentSha(item: NormalizedFeedItem): string {
  const text = `${item.title}\n${item.summary}\n${item.author_name}`;
  return sha256(text);
}

/**
 * Check if a route qualifies for monetization.
 * Route must be: verification_status='verified' AND is_monetized=true AND creator_wallet present.
 */
function isRouteMonetized(route: RsshubRoute): boolean {
  return (
    route.verification_status === "verified" &&
    route.is_monetized === true &&
    !!route.creator_wallet
  );
}

/**
 * Sync all active routes, or a single route by id.
 */
export async function syncRsshub(
  routeId?: string
): Promise<SyncSummary> {
  const started = new Date().toISOString();
  const errors: string[] = [];
  let routesSynced = 0;
  let itemsSeen = 0;
  let itemsUpserted = 0;
  let monetizedItems = 0;
  let unmonetizedItems = 0;

  // Load routes — include monetization fields
  let query = supabaseAdmin()
    .from("paylabs_rsshub_routes")
    .select(
      "id, rsshub_base_url, route_path, title, creator_wallet, is_monetized, default_price_per_citation_usdc, default_price_per_unlock_usdc, verification_status"
    )
    .eq("is_active", true);

  if (routeId) {
    query = query.eq("id", routeId);
  }

  const { data: routes, error: routeError } = await query;

  if (routeError) {
    return {
      sync_started_at: started,
      sync_finished_at: new Date().toISOString(),
      routes_synced: 0,
      items_seen: 0,
      items_upserted: 0,
      monetized_items: 0,
      unmonetized_items: 0,
      errors: [`Failed to load routes: ${routeError.message}`],
    };
  }

  if (!routes || routes.length === 0) {
    return {
      sync_started_at: started,
      sync_finished_at: new Date().toISOString(),
      routes_synced: 0,
      items_seen: 0,
      items_upserted: 0,
      monetized_items: 0,
      unmonetized_items: 0,
      errors: routeId ? [`Route ${routeId} not found or inactive`] : [],
    };
  }

  const maxItems = Number(process.env.PAYLABS_RSSHUB_MAX_ITEMS_PER_ROUTE) || 25;

  for (const route of routes as RsshubRoute[]) {
    const result = await fetchRoute(
      route.rsshub_base_url,
      route.route_path,
      maxItems
    );

    if (!result.ok) {
      errors.push(`[${route.title}] ${result.error}`);
      continue;
    }

    routesSynced++;
    itemsSeen += result.items.length;

    // Monetization gate: only verified + monetized routes get wallet + prices
    const monetized = isRouteMonetized(route);

    for (const item of result.items) {
      const normalizedSha = computeNormalizedSha(item);
      const contentSha = computeContentSha(item);

      const row = {
        rsshub_route_id: route.id,
        canonical_url: item.canonical_url,
        title: item.title,
        summary: item.summary,
        author_name: item.author_name,
        publisher: item.publisher,
        published_at: item.published_at,
        tags: item.tags,
        normalized_sha256: normalizedSha,
        content_sha256: contentSha,
        // Monetization gate: wallet and prices only for verified+monetized routes
        creator_wallet: monetized ? route.creator_wallet : null,
        is_monetized: monetized,
        price_per_citation_usdc: monetized ? route.default_price_per_citation_usdc : 0,
        price_per_unlock_usdc: monetized ? route.default_price_per_unlock_usdc : 0,
        source_payload: item.raw,
        is_active: true,
      };

      const { error: upsertError } = await supabaseAdmin()
        .from("paylabs_feed_items")
        .upsert(row, { onConflict: "canonical_url" });

      if (upsertError) {
        errors.push(
          `[${route.title}] upsert failed for ${item.canonical_url}: ${upsertError.message}`
        );
      } else {
        itemsUpserted++;
        if (monetized) {
          monetizedItems++;
        } else {
          unmonetizedItems++;
        }
      }
    }

    // Update last_synced_at
    await supabaseAdmin()
      .from("paylabs_rsshub_routes")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", route.id);
  }

  return {
    sync_started_at: started,
    sync_finished_at: new Date().toISOString(),
    routes_synced: routesSynced,
    items_seen: itemsSeen,
    items_upserted: itemsUpserted,
    monetized_items: monetizedItems,
    unmonetized_items: unmonetizedItems,
    errors,
  };
}
