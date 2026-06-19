/**
 * Feed Tools
 * Read-only tools for RSSHub feed item queries.
 * Used by the curriculum planner agent for source path proposals.
 *
 * Rules:
 * - Only expose safe metadata to LLM (never source_payload)
 * - Never trust LLM for price/wallet/source URL
 * - All price/wallet data comes from DB
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Types ──────────────────────────────────────────────────────

export interface FeedItem {
  id: string;
  rsshub_route_id: string;
  canonical_url: string;
  title: string | null;
  summary: string | null;
  author_name: string | null;
  publisher: string | null;
  published_at: string | null;
  tags: string[] | null;
  normalized_sha256: string | null;
  content_sha256: string | null;
  creator_wallet: string;
  price_per_citation_usdc: number;
  price_per_unlock_usdc: number;
  is_active: boolean;
}

export interface SafeFeedItem {
  feed_item_id: string;
  title: string | null;
  summary: string | null;
  author_name: string | null;
  publisher: string | null;
  tags: string[] | null;
  published_at: string | null;
  price_per_citation_usdc: number;
  price_per_unlock_usdc: number;
  has_normalized_hash: boolean;
  has_content_hash: boolean;
}

// ─── Read-Only Tools ────────────────────────────────────────────

/**
 * List active feed items from paylabs_feed_items.
 * Returns full FeedItem objects (server use only).
 */
export async function listActiveFeedItems(limit?: number): Promise<FeedItem[]> {
  let query = supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, canonical_url, title, summary, author_name, publisher,
       published_at, tags, normalized_sha256, content_sha256,
       creator_wallet, price_per_citation_usdc, price_per_unlock_usdc, is_active`
    )
    .eq("is_active", true)
    .order("published_at", { ascending: false });

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to fetch feed items: ${error.message}`);
  return (data || []) as FeedItem[];
}

/**
 * Get a single feed item by ID.
 */
export async function getFeedItemById(feedItemId: string): Promise<FeedItem | null> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, canonical_url, title, summary, author_name, publisher,
       published_at, tags, normalized_sha256, content_sha256,
       creator_wallet, price_per_citation_usdc, price_per_unlock_usdc, is_active`
    )
    .eq("id", feedItemId)
    .single();

  if (error) return null;
  return data as FeedItem;
}

/**
 * Build safe metadata for LLM — never expose source_payload or raw wallet/URL.
 * Only exposes what the LLM needs to make selection decisions.
 */
export function buildSafeFeedItemMetadata(items: FeedItem[]): SafeFeedItem[] {
  return items.map((item) => ({
    feed_item_id: item.id,
    title: item.title,
    summary: item.summary,
    author_name: item.author_name,
    publisher: item.publisher,
    tags: item.tags,
    published_at: item.published_at,
    price_per_citation_usdc: item.price_per_citation_usdc,
    price_per_unlock_usdc: item.price_per_unlock_usdc,
    has_normalized_hash: !!item.normalized_sha256,
    has_content_hash: !!item.content_sha256,
  }));
}

/**
 * Validate a feed item candidate selected by LLM.
 * Returns the full FeedItem if valid, or an error message.
 */
export async function validateFeedItemCandidate(
  feedItemId: string
): Promise<{ ok: boolean; item?: FeedItem; error?: string }> {
  const item = await getFeedItemById(feedItemId);
  if (!item) {
    return { ok: false, error: `Feed item ${feedItemId} not found` };
  }
  if (!item.is_active) {
    return { ok: false, error: `Feed item ${feedItemId} is not active` };
  }
  if (!item.canonical_url) {
    return { ok: false, error: `Feed item ${feedItemId} has no canonical_url` };
  }
  if (!item.creator_wallet) {
    return { ok: false, error: `Feed item ${feedItemId} has no creator_wallet` };
  }
  if (!item.normalized_sha256 && !item.content_sha256) {
    return { ok: false, error: `Feed item ${feedItemId} has no content hash` };
  }
  return { ok: true, item };
}
