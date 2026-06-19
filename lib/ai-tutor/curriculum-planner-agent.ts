/**
 * Agent 2: Curriculum Planner Agent (LLM-powered)
 * Picks RSSHub feed items that fit the goal and budget.
 * No payment, no Runner — read-only.
 *
 * Primary path: RSSHub source paths from paylabs_feed_items.
 * Legacy fallback: lessons from paylabs_lessons (only if no feed items).
 *
 * Calls actual LLM via invokeJsonAgent with route-specific prompt.
 * Server always re-validates: IDs exist, active, budget, max price, max count.
 * Server recomputes price — never trust LLM price.
 * Server fills wallet/price/source URL from DB — never from LLM.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import {
  listActiveFeedItems,
  buildSafeFeedItemMetadata,
  type FeedItem,
  type SafeFeedItem,
} from "./feed-tools";
import { listPublishedLessons, getUserUnlocks } from "./tools";
import { z } from "zod";

// ─── Zod schemas for LLM structured output ──────────────────────

const SourcePlannerSchema = z.object({
  selected_feed_items: z
    .array(
      z.object({
        feed_item_id: z.string().describe("The feed item ID to include in the path"),
        reason: z.string().describe("Why this feed item was selected for the user's goal"),
        expected_value: z.string().describe("What the user will learn/gain from this source"),
      })
    )
    .describe("Selected RSSHub feed items for the source path, ordered"),
  planner_notes: z
    .array(z.string())
    .describe("Notes about the planning decisions"),
});

type SourcePlannerResult = z.infer<typeof SourcePlannerSchema>;

const LegacyPlannerSchema = z.object({
  selected_lessons: z.array(
    z.object({
      lesson_id: z.string().describe("The lesson ID to include in the path"),
      reason: z.string().describe("Why this lesson was selected for the user's goal"),
      expected_value: z.string().describe("What the user will learn from this lesson"),
    })
  ).describe("Selected lessons for the learning path, ordered"),
  planner_notes: z.array(z.string()).describe("Notes about the planning decisions"),
});

type LegacyPlannerResult = z.infer<typeof LegacyPlannerSchema>;

// ─── Safe lesson metadata for LLM (legacy) ──────────────────────

function buildSafeLessonMetadata(
  lessons: Record<string, unknown>[],
  unlockedIds: string[]
): Record<string, unknown>[] {
  return lessons
    .filter((l) => !unlockedIds.includes(l.id as string))
    .map((l) => {
      const source = l.source as Record<string, unknown> | undefined;
      const creator = l.creator as Record<string, unknown> | undefined;
      return {
        lesson_id: l.id,
        title: l.title,
        summary: l.summary,
        tags: l.tags,
        difficulty: l.difficulty,
        price_usdc: l.price_usdc,
        source_hash_present: !!source?.normalized_sha256,
        content_hash_present: !!l.content_sha256,
        creator_verified: !!creator?.is_verified,
      };
    });
}

// ─── Server re-validation: RSSHub source path ───────────────────

function revalidateSourceSelection(
  llmSelection: SourcePlannerResult,
  availableItems: FeedItem[],
  budget: number,
  maxSourceCards: number
): {
  selected: Record<string, unknown>[];
  rejected: string[];
  totalUsdc: number;
} {
  const selected: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  let remaining = budget;

  for (const item of llmSelection.selected_feed_items) {
    if (selected.length >= maxSourceCards) {
      rejected.push(`${item.feed_item_id}: max source cards reached`);
      continue;
    }

    const feedItem = availableItems.find((f) => f.id === item.feed_item_id);
    if (!feedItem) {
      rejected.push(`${item.feed_item_id}: not found in available feed items`);
      continue;
    }

    if (!feedItem.is_active) {
      rejected.push(`${item.feed_item_id}: feed item not active`);
      continue;
    }

    if (!feedItem.canonical_url) {
      rejected.push(`${item.feed_item_id}: no canonical_url`);
      continue;
    }

    if (!feedItem.creator_wallet) {
      rejected.push(`${item.feed_item_id}: no creator_wallet`);
      continue;
    }

    // Validate creator wallet is valid EVM address
    if (!/^0x[0-9a-fA-F]{40}$/.test(feedItem.creator_wallet)) {
      rejected.push(`${item.feed_item_id}: creator_wallet not valid EVM address`);
      continue;
    }

    if (!feedItem.normalized_sha256 && !feedItem.content_sha256) {
      rejected.push(`${item.feed_item_id}: no content hash`);
      continue;
    }

    // Price comes from DB — NEVER from LLM
    const citationPrice = Number(feedItem.price_per_citation_usdc) || 0;
    if (citationPrice > remaining) {
      rejected.push(
        `${item.feed_item_id}: citation price ${citationPrice} exceeds remaining budget ${remaining}`
      );
      continue;
    }

    selected.push({
      feed_item_id: item.feed_item_id,
      order_index: selected.length,
      // All data from DB — never from LLM
      citation_price_usdc: citationPrice,
      unlock_price_usdc: Number(feedItem.price_per_unlock_usdc) || 0,
      creator_wallet: feedItem.creator_wallet,
      source_url: feedItem.canonical_url,
      source_title: feedItem.title,
      source_hash: feedItem.normalized_sha256 || feedItem.content_sha256,
      reason: item.reason,
      expected_value: item.expected_value,
    });
    remaining -= citationPrice;
  }

  const totalUsdc = selected.reduce(
    (sum, s) => sum + (s.citation_price_usdc as number),
    0
  );

  return { selected, rejected, totalUsdc };
}

// ─── Server re-validation: Legacy lesson path ───────────────────

function revalidateLessonSelection(
  llmSelection: LegacyPlannerResult,
  available: Record<string, unknown>[],
  unlockedIds: string[],
  budget: number,
  maxPrice: number,
  maxLessons: number
): { selected: Record<string, unknown>[]; rejected: string[] } {
  const selected: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  let remaining = budget;

  for (const item of llmSelection.selected_lessons) {
    if (selected.length >= maxLessons) {
      rejected.push(`${item.lesson_id}: max lessons reached`);
      continue;
    }

    const lesson = available.find((l) => l.id === item.lesson_id);
    if (!lesson) {
      rejected.push(`${item.lesson_id}: not found in available lessons`);
      continue;
    }

    if (unlockedIds.includes(item.lesson_id)) {
      rejected.push(`${item.lesson_id}: already unlocked`);
      continue;
    }

    const price = Number(lesson.price_usdc) || 0;
    if (price > maxPrice) {
      rejected.push(`${item.lesson_id}: price ${price} exceeds max ${maxPrice}`);
      continue;
    }

    if (price > remaining) {
      rejected.push(`${item.lesson_id}: price ${price} exceeds remaining budget ${remaining}`);
      continue;
    }

    selected.push({
      lesson_id: item.lesson_id,
      order_index: selected.length,
      price_usdc: price,
      title: lesson.title,
      slug: lesson.slug,
      reason: item.reason,
      expected_value: item.expected_value,
    });
    remaining -= price;
  }

  return { selected, rejected };
}

// ─── Main agent ─────────────────────────────────────────────────

export async function curriculumPlannerAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, topics, budgetUsdc, maxLessonPriceUsdc, routeTier, routePrompts } = state;
  const goal = state.normalizedGoal || state.goal || "";
  const budget = budgetUsdc || 0;
  const maxPrice = maxLessonPriceUsdc || 0.05;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);
  const maxSourceCards = config.maxSourceCards;
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  try {
    // ── Primary path: RSSHub feed items ──
    const feedItems = await listActiveFeedItems();

    if (feedItems.length > 0) {
      return await planSourcePath({
        feedItems,
        goal,
        budget,
        maxSourceCards,
        tier,
        config,
        prompts,
        topics: topics || [],
      });
    }

    // ── Fallback: Legacy lesson path ──
    const lessons = (await listPublishedLessons()) as Record<string, unknown>[];
    const unlockedIds = await getUserUnlocks(userWallet);
    const available = lessons.filter((l) => !unlockedIds.includes(l.id as string));

    if (available.length === 0) {
      return {
        error:
          "No RSSHub feed items available. Create RSSHub routes and run sync first.",
        selectedLessons: [],
        selectedFeedItems: [],
        plannerNotes: [
          "No RSSHub feed items available. Create RSSHub routes and run sync first.",
        ],
      };
    }

    return await planLessonPath({
      available,
      unlockedIds,
      goal,
      budget,
      maxPrice,
      maxLessons: config.maxLessons,
      tier,
      config,
      prompts,
      topics: topics || [],
      allLessons: lessons,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Curriculum planning failed: ${msg}` };
  }
}

// ─── RSSHub Source Path Planning ─────────────────────────────────

async function planSourcePath(input: {
  feedItems: FeedItem[];
  goal: string;
  budget: number;
  maxSourceCards: number;
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  prompts: ReturnType<typeof getPromptsForRoute>;
  topics: string[];
}): Promise<Partial<PayLabsTutorStateType>> {
  const { feedItems, goal, budget, maxSourceCards, tier, config, prompts, topics } = input;

  const safeFeedItems = buildSafeFeedItemMetadata(feedItems);

  // Call LLM
  const llmResult = await invokeJsonAgent<SourcePlannerResult>({
    agentName: "curriculum_planner",
    routeTier: tier,
    prompt: prompts.curriculumPlanner,
    userMessage: `User goal: "${goal}"\nTopics: ${topics.join(", ")}\nBudget: ${budget} USDC\nRoute tier: ${tier}\nMax source cards: ${maxSourceCards}\n\nAvailable RSSHub feed items (JSON):\n${JSON.stringify(safeFeedItems, null, 2)}\n\nSelect up to ${maxSourceCards} feed items that best fit the goal and budget. For each, explain why it was selected and what the user will learn.`,
    schema: SourcePlannerSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as {
      ok: false;
      error: string;
      meta: Record<string, unknown>;
    };
    return {
      error: `Curriculum Planner LLM failed: ${errResult.error}`,
      llmErrors: { curriculum_planner: errResult },
      agentTrace: { curriculum_planner: errResult.meta },
    };
  }

  const data = (llmResult as { ok: true; data: SourcePlannerResult; meta: Record<string, unknown> }).data;
  const meta = (llmResult as { ok: true; data: SourcePlannerResult; meta: Record<string, unknown> }).meta;

  // Server re-validates LLM output — NEVER trust LLM for prices/wallets/URLs
  const validated = revalidateSourceSelection(data, feedItems, budget, maxSourceCards);

  const plannerNotes: string[] = [
    `Route: ${config.label} (max ${maxSourceCards} source cards)`,
    `LLM selected ${data.selected_feed_items.length}, server validated ${validated.selected.length}`,
    `Total: ${validated.totalUsdc.toFixed(6)} USDC of ${budget} budget`,
    ...data.planner_notes,
  ];
  if (validated.rejected.length > 0) {
    plannerNotes.push(`Server rejected: ${validated.rejected.join("; ")}`);
  }

  return {
    availableFeedItems: feedItems,
    selectedFeedItems: validated.selected,
    sourcePathTotalUsdc: validated.totalUsdc,
    sourceCardCount: validated.selected.length,
    remainingUsdc: budget - validated.totalUsdc,
    plannerNotes,
    agentTrace: { curriculum_planner: meta },
    llmOutputs: { curriculum_planner: data },
    // Do NOT fill selectedLessons for RSSHub source paths
  };
}

// ─── Legacy Lesson Path Planning ────────────────────────────────

async function planLessonPath(input: {
  available: Record<string, unknown>[];
  unlockedIds: string[];
  goal: string;
  budget: number;
  maxPrice: number;
  maxLessons: number;
  tier: RouteTier;
  config: ReturnType<typeof getRouteConfig>;
  prompts: ReturnType<typeof getPromptsForRoute>;
  topics: string[];
  allLessons: Record<string, unknown>[];
}): Promise<Partial<PayLabsTutorStateType>> {
  const { available, unlockedIds, goal, budget, maxPrice, maxLessons, tier, config, prompts, topics, allLessons } = input;

  const safeLessons = buildSafeLessonMetadata(available, unlockedIds);

  // Call LLM
  const llmResult = await invokeJsonAgent<LegacyPlannerResult>({
    agentName: "curriculum_planner",
    routeTier: tier,
    prompt: prompts.curriculumPlanner,
    userMessage: `User goal: "${goal}"\nTopics: ${topics.join(", ")}\nBudget: ${budget} USDC\nRoute tier: ${tier}\nMax lessons: ${maxLessons}\nMax lesson price: ${maxPrice} USDC\n\nAvailable lessons (JSON):\n${JSON.stringify(safeLessons, null, 2)}\n\nSelect up to ${maxLessons} lessons that best fit the goal and budget.`,
    schema: LegacyPlannerSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as {
      ok: false;
      error: string;
      meta: Record<string, unknown>;
    };
    return {
      error: `Curriculum Planner LLM failed: ${errResult.error}`,
      llmErrors: { curriculum_planner: errResult },
      agentTrace: { curriculum_planner: errResult.meta },
    };
  }

  const data = (llmResult as { ok: true; data: LegacyPlannerResult; meta: Record<string, unknown> }).data;
  const meta = (llmResult as { ok: true; data: LegacyPlannerResult; meta: Record<string, unknown> }).meta;

  const validated = revalidateLessonSelection(data, available, unlockedIds, budget, maxPrice, maxLessons);

  const estimatedTotal = validated.selected.reduce(
    (sum, l) => sum + (l.price_usdc as number),
    0
  );

  const plannerNotes: string[] = [
    `Route: ${config.label} (max ${maxLessons} lessons, legacy mode)`,
    `LLM selected ${data.selected_lessons.length}, server validated ${validated.selected.length}`,
    `Total: ${estimatedTotal.toFixed(6)} USDC of ${budget} budget`,
    ...data.planner_notes,
  ];
  if (validated.rejected.length > 0) {
    plannerNotes.push(`Server rejected: ${validated.rejected.join("; ")}`);
  }

  return {
    publishedLessons: allLessons,
    unlockedLessonIds: unlockedIds,
    selectedLessons: validated.selected,
    estimatedTotalUsdc: estimatedTotal,
    remainingUsdc: budget - estimatedTotal,
    plannerNotes,
    agentTrace: { curriculum_planner: meta },
    llmOutputs: { curriculum_planner: data },
  };
}
