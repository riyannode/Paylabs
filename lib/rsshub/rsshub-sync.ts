/**
 * RSSHub Sync
 *
 * Loads active routes, fetches each, upserts into paylabs_feed_items.
 * Uses creator wallet and prices from route config (not LLM).
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
  errors: string[];
}

interface RsshubRoute {
  id: string;
  rsshub_base_url: string;
  route_path: string;
  title: string;
  creator_wallet: string;
  default_price_per_citation_usdc: number;
  default_price_per_unlock_usdc: number;
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

  // Load routes
  let query = supabaseAdmin()
    .from("paylabs_rsshub_routes")
    .select(
      "id, rsshub_base_url, route_path, title, creator_wallet, default_price_per_citation_usdc, default_price_per_unlock_usdc"
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
        creator_wallet: route.creator_wallet,
        price_per_citation_usdc: route.default_price_per_citation_usdc,
        price_per_unlock_usdc: route.default_price_per_unlock_usdc,
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
    errors,
  };
}
