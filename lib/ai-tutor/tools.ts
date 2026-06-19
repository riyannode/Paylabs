/**
 * PayLabs Tutor Tools
 * Read-only tools for lesson queries + privileged tools for Runner execution.
 * Trust boundary: privileged tools go through ArcLayer Runner only.
 */

import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Read-Only Tools ─────────────────────────────────────────────

export async function listPublishedLessons() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select(
      `id, slug, title, summary, price_usdc, estimated_minutes, difficulty, tags,
       content_sha256, is_published,
       source:paylabs_sources(id, canonical_url, source_title, publisher, normalized_sha256),
       creator:paylabs_creators(id, wallet_address, display_name, is_verified)`
    )
    .eq("is_published", true)
    .order("price_usdc");

  if (error) throw new Error(`Failed to fetch lessons: ${error.message}`);
  return data || [];
}

export async function getUserUnlocks(userWallet: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .select("lesson_id")
    .eq("user_wallet", userWallet.toLowerCase());

  if (error) throw new Error(`Failed to fetch unlocks: ${error.message}`);
  return (data || []).map((u: { lesson_id: string }) => u.lesson_id);
}

export async function getLessonById(lessonId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select(
      `id, slug, title, summary, price_usdc, difficulty, tags, content_sha256, is_published,
       source_id, creator_id,
       source:paylabs_sources(id, canonical_url, normalized_sha256),
       creator:paylabs_creators(wallet_address, is_verified)`
    )
    .eq("id", lessonId)
    .single();

  if (error) throw new Error(`Lesson not found: ${error.message}`);
  return data;
}

export async function getPathById(pathId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_learning_paths")
    .select("*")
    .eq("id", pathId)
    .single();

  if (error) throw new Error(`Path not found: ${error.message}`);
  return data;
}

export async function getPathItems(pathId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_learning_path_items")
    .select(
      `id, path_id, lesson_id, order_index, reason, expected_value, status,
       lesson:paylabs_lessons(id, slug, title, price_usdc)`
    )
    .eq("path_id", pathId)
    .order("order_index");

  if (error) throw new Error(`Failed to fetch path items: ${error.message}`);
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
  pathId: string,
  lessonId: string
): Promise<PolicyCheckResult> {
  const checks: Record<string, boolean> = {};

  // 1. Path exists and belongs to user
  const path = await getPathById(pathId);
  checks.path_exists = !!path;
  checks.path_owned_by_user =
    path?.user_wallet?.toLowerCase() === userWallet.toLowerCase();
  checks.path_approved =
    path?.status === "approved" || path?.status === "active";

  if (!checks.path_exists || !checks.path_owned_by_user || !checks.path_approved) {
    return {
      allowed: false,
      reason: `Path validation failed: exists=${checks.path_exists}, owned=${checks.path_owned_by_user}, approved=${checks.path_approved}`,
      checks,
    };
  }

  // 2. Lesson in path
  const pathItems = await getPathItems(pathId) as Record<string, unknown>[];
  const pathItem = pathItems.find(
    (pi) => pi.lesson_id === lessonId
  );
  checks.lesson_in_path = !!pathItem;

  if (!checks.lesson_in_path) {
    return { allowed: false, reason: "Lesson is not in the approved path", checks };
  }

  // 3. Lesson validation
  const lesson = await getLessonById(lessonId);
  // Supabase FK joins return objects at runtime, but TS types say array.
  // Cast to Record for safe property access.
  const source = lesson?.source as unknown as Record<string, unknown> | undefined;
  const creator = lesson?.creator as unknown as Record<string, unknown> | undefined;
  checks.lesson_published = lesson?.is_published === true;
  checks.source_hash_present = !!source?.normalized_sha256;
  checks.content_hash_present = !!lesson?.content_sha256;
  checks.creator_verified = creator?.is_verified === true;

  // 4. Not already unlocked
  const unlockIds = await getUserUnlocks(userWallet);
  checks.not_already_unlocked = !unlockIds.includes(lessonId);

  // 5. Budget
  const spent = pathItems
    .filter((pi) => {
      const s = pi.status as string;
      return s === "unlocked" || s === "completed";
    })
    .reduce((sum: number, pi) => {
      const l = pi.lesson as Record<string, unknown> | undefined;
      return sum + Number((l?.price_usdc as number) || 0);
    }, 0);
  const remaining = Number(path.budget_usdc) - spent;
  checks.within_remaining_budget = Number(lesson?.price_usdc || 999) <= remaining;

  const maxLessonPrice = Number(
    process.env.PAYLABS_MAX_LESSON_PRICE_USDC || "0.05"
  );
  checks.within_max_lesson_price =
    Number(lesson?.price_usdc || 999) <= maxLessonPrice;

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
