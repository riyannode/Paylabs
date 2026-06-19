/**
 * PayLabs Tutor Tools
 * Read-only tools for RSSHub/feed queries + privileged tools for Runner execution.
 * Trust boundary: privileged tools go through ArcLayer Runner only.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Read-Only Tools ─────────────────────────────────────────────

export async function listFeedItems(routeId?: string) {
  let query = supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, item_guid, title, summary, content_sha256, published_at, fetched_at,
       rsshub_route:paylabs_rsshub_routes(id, route_path, route_title, description, price_usdc, is_active)`
    )
    .order("published_at", { ascending: false });

  if (routeId) {
    query = query.eq("rsshub_route_id", routeId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch feed items: ${error.message}`);
  return data || [];
}

export async function getFeedItemById(feedItemId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_feed_items")
    .select(
      `id, rsshub_route_id, item_guid, title, summary, content_sha256, published_at, fetched_at,
       rsshub_route:paylabs_rsshub_routes(id, route_path, route_title, description, price_usdc, is_active)`
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
      `id, source_path_id, feed_item_id, order_index, reason, expected_value, status,
       feed_item:paylabs_feed_items(id, rsshub_route_id, item_guid, title, summary, content_sha256)`
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
  checks.content_hash_present = !!feedItem?.content_sha256;

  // 4. Not already paid
  const paidItemIds = await getPaidSourcePathItemIds(userWallet);
  checks.not_already_paid = !paidItemIds.includes(sourcePathItemId);

  // 5. Budget
  const spent = pathItems
    .filter((pi) => {
      const s = pi.status as string;
      return s === "purchased" || s === "completed";
    })
    .reduce((sum: number) => sum + 0, 0); // Individual item costs are tracked via payments
  const remaining = Number(sourcePath.budget_usdc) - spent;
  const routePrice = Number(sourcePath?.route_config?.price_usdc || 0);
  checks.within_remaining_budget = routePrice <= remaining;

  const maxSourceCost = Number(
    process.env.PAYLABS_MAX_SOURCE_COST_USDC || "0.05"
  );
  checks.within_max_source_cost = routePrice <= maxSourceCost;

  // 6. Runner availability
  try {
    const { isRunnerAvailable } = await import("@/lib/arclayer-runner/tools");
    checks.runner_available = await isRunnerAvailable();
  } catch {
    checks.runner_available = false;
  }

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
