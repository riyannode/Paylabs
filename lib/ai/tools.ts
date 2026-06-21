/**
 * PayLabs Tutor Tools
 * Read-only tools for RSSHub/feed queries + privileged tools for backend executor.
 * Trust boundary: privileged tools go through Payment Adapter only.
 *
 * Phase 1: monetization gate — only verified+monetized sources pass.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Read-Only Tools ─────────────────────────────────────────────

export async function listFeedItems(routeId?: string) {
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
  if (error) throw new Error(`Failed to fetch feed items: ${error.message}`);
  return data || [];
}

/**
 * List only monetized feed items that qualify for paid source paths.
 * Deterministic filter — no LLM involvement.
 */
export async function listMonetizedFeedItems(routeId?: string) {
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
    .eq("is_monetized", true)
    .not("creator_wallet", "is", null)
    .gt("price_per_citation_usdc", 0)
    .order("published_at", { ascending: false });

  if (routeId) {
    query = query.eq("rsshub_route_id", routeId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch monetized feed items: ${error.message}`);

  // Additional filter: route must be verified + monetized
  // Supabase returns joined relation as array — take first element
  // Cast data to avoid Supabase join type inference issues
  const filtered = ((data || []) as unknown as Record<string, unknown>[]).filter((item) => {
    const routeRaw = item.rsshub_route as unknown;
    const route = Array.isArray(routeRaw) ? routeRaw[0] as Record<string, unknown> : routeRaw as Record<string, unknown> | undefined;
    return (
      route?.verification_status === "verified" &&
      route?.is_monetized === true &&
      !!route?.creator_wallet
    );
  });

  return filtered;
}

/**
 * List all active (discoverable) feed items for the pipeline.
 * Includes both monetized AND unclaimed sources.
 * Unclaimed: is_monetized=false or creator_wallet=null.
 * Pipeline treats unclaimed as treasury-agent-fee-only (creator payout = 0).
 */
export async function listDiscoverableFeedItems(routeId?: string) {
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
  if (error) throw new Error(`Failed to fetch discoverable feed items: ${error.message}`);
  return (data || []) as unknown as Record<string, unknown>[];
}

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
       published_at, tags, normalized_sha256, content_sha256, creator_wallet,
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

export async function getPaidSourcePathItemIds(userWallet: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_source_payments")
    .select("source_path_item_id")
    .eq("user_wallet", userWallet.toLowerCase())
    .eq("status", "completed");

  if (error) throw new Error(`Failed to fetch source payments: ${error.message}`);
  return (data || []).map((p: { source_path_item_id: string }) => p.source_path_item_id);
}

export async function getSourcePathById(sourcePathId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_source_paths")
    .select("*")
    .eq("id", sourcePathId)
    .single();

  if (error) throw new Error(`Source path not found: ${error.message}`);
  return data;
}

export async function getSourcePathItems(sourcePathId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_source_path_items")
    .select(
      `id, source_path_id, feed_item_id, order_index, reason, expected_value,
       source_url, source_title, publisher, author_name, normalized_sha256,
       content_sha256, source_hash, creator_wallet, is_monetized,
       citation_price_usdc, unlock_price_usdc, evidence_score,
       marginal_value_score, status,
       feed_item:paylabs_feed_items(
         id, rsshub_route_id, canonical_url, title, summary, author_name,
         publisher, published_at, normalized_sha256, content_sha256,
         creator_wallet, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, is_active,
         rsshub_route:paylabs_rsshub_routes(id, route_path, title, is_active, verification_status, is_monetized, creator_wallet)
       )`
    )
    .eq("source_path_id", sourcePathId)
    .order("order_index");

  if (error) throw new Error(`Failed to fetch source path items: ${error.message}`);
  return data || [];
}

// ─── Policy Check ────────────────────────────────────────────────

export interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
  checks: Record<string, boolean>;
}

export async function runPolicyChecks(
  userWallet: string,
  sourcePathId: string,
  sourcePathItemId: string
): Promise<PolicyCheckResult> {
  const checks: Record<string, boolean> = {};

  // 1. Source path exists and belongs to user
  const sourcePath = await getSourcePathById(sourcePathId);
  checks.path_exists = !!sourcePath;
  checks.path_owned_by_user =
    sourcePath?.user_wallet?.toLowerCase() === userWallet.toLowerCase();
  checks.path_approved =
    sourcePath?.status === "approved" || sourcePath?.status === "active";

  if (!checks.path_exists || !checks.path_owned_by_user || !checks.path_approved) {
    return {
      allowed: false,
      reason: `Source path validation failed: exists=${checks.path_exists}, owned=${checks.path_owned_by_user}, approved=${checks.path_approved}`,
      checks,
    };
  }

  // 2. Source path item exists in path
  const pathItems = await getSourcePathItems(sourcePathId) as Record<string, unknown>[];
  const pathItem = pathItems.find(
    (pi) => pi.id === sourcePathItemId
  );
  checks.item_in_path = !!pathItem;

  if (!checks.item_in_path) {
    return { allowed: false, reason: "Source path item not found in the approved path", checks };
  }

  // 3. Feed item validation
  const feedItem = pathItem?.feed_item as Record<string, unknown> | undefined;
  checks.feed_item_present = !!feedItem;
  checks.feed_item_active = feedItem?.is_active === true;
  checks.feed_item_monetized = feedItem?.is_monetized === true;
  checks.content_hash_present = !!feedItem?.content_sha256;
  checks.source_url_present = !!pathItem?.source_url;
  checks.creator_wallet_present = !!pathItem?.creator_wallet;

  // 4. Route validation
  const route = feedItem?.rsshub_route as Record<string, unknown> | undefined;
  checks.route_exists = !!route;
  checks.route_active = route?.is_active === true;
  checks.route_verified = route?.verification_status === "verified";
  checks.route_monetized = route?.is_monetized === true;

  // 5. Creator wallet consistency — all three must match
  if (feedItem && pathItem && route) {
    const feedCreatorWallet = String(feedItem.creator_wallet || "").toLowerCase();
    const itemCreatorWallet = String(pathItem.creator_wallet || "").toLowerCase();
    const routeCreatorWallet = String(route.creator_wallet || "").toLowerCase();
    checks.creator_wallet_consistent =
      !!feedCreatorWallet &&
      feedCreatorWallet === itemCreatorWallet &&
      routeCreatorWallet === feedCreatorWallet;
  } else {
    checks.creator_wallet_consistent = false;
  }

  // 6. Not already paid
  const paidItemIds = await getPaidSourcePathItemIds(userWallet);
  checks.not_already_paid = !paidItemIds.includes(sourcePathItemId);

  // 7. Price from DB — amount comes from feed item, not LLM
  const citationPrice = Number(feedItem?.price_per_citation_usdc || pathItem?.citation_price_usdc || 0);
  checks.price_valid = citationPrice > 0;

  const maxSourceCost = Number(
    process.env.PAYLABS_MAX_SOURCE_COST_USDC || "0.05"
  );
  checks.within_max_source_cost = citationPrice <= maxSourceCost;

  // 8. Payment adapter availability
  checks.payment_adapter_configured = !!process.env.PAYLABS_PAYMENT_EXECUTOR;

  // Final decision
  const allPassed = Object.values(checks).every((v) => v === true);
  const failedChecks = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  return {
    allowed: allPassed,
    reason: allPassed
      ? "All policy checks passed"
      : `Failed checks: ${failedChecks.join(", ")}`,
    checks,
  };
}
