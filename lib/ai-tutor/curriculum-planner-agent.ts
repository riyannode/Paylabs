/**
 * Agent 2: Curriculum Planner Agent
 * Picks source-backed lessons that fit the goal and budget.
 * No payment, no Runner — read-only.
 * Route tier controls max lessons and planner style.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { listPublishedLessons, getUserUnlocks } from "./tools";

function scoreLesson(
  lesson: Record<string, unknown>,
  topics: string[],
  goal: string
): number {
  let score = 0;
  const title = ((lesson.title as string) || "").toLowerCase();
  const summary = ((lesson.summary as string) || "").toLowerCase();
  const tags = (lesson.tags as string[]) || [];
  const text = `${title} ${summary} ${tags.join(" ")}`;

  // Topic match
  for (const topic of topics) {
    if (text.includes(topic)) score += 3;
  }

  // Goal word match
  for (const word of goal.split(/\s+/)) {
    if (word.length > 2 && text.includes(word)) score += 2;
  }

  // Source-backed bonus
  const source = lesson.source as Record<string, unknown> | undefined;
  if (source?.normalized_sha256) score += 2;
  if (lesson.content_sha256) score += 1;

  // Verified creator bonus
  const creator = lesson.creator as Record<string, unknown> | undefined;
  if (creator?.is_verified) score += 1;

  // Price efficiency (lower price = higher score)
  const price = Number(lesson.price_usdc) || 1;
  score += (1 / price) * 0.001;

  return score;
}

export async function curriculumPlannerAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, topics, budgetUsdc, maxLessonPriceUsdc, routeTier } = state;
  const goal = state.normalizedGoal || state.goal || "";
  const budget = budgetUsdc || 0;
  const maxPrice = maxLessonPriceUsdc || 0.05;
  const tier: RouteTier = routeTier || "normal";
  const config = getRouteConfig(tier);
  const maxLessons = config.maxLessons;

  try {
    // Fetch published lessons and user unlocks
    const lessons = (await listPublishedLessons()) as Record<string, unknown>[];
    const unlockedIds = await getUserUnlocks(userWallet);

    // Filter out already unlocked
    const available = lessons.filter(
      (l) => !unlockedIds.includes(l.id as string)
    );

    if (available.length === 0) {
      return {
        error: "No available lessons",
        selectedLessons: [],
        plannerNotes: ["No published lessons available after excluding unlocked"],
      };
    }

    // Score and sort
    const scored: (Record<string, unknown> & { _score: number })[] = available.map((l) => ({
      ...l,
      _score: scoreLesson(l, topics || [], goal),
    }));
    scored.sort((a, b) => b._score - a._score);

    // Greedy selection within budget — max lessons from route config
    const selected: Record<string, unknown>[] = [];
    let remaining = budget;

    for (const lesson of scored) {
      const price = Number(lesson.price_usdc) || 0;
      if (price <= remaining && price <= maxPrice && selected.length < maxLessons) {
        selected.push({
          lesson_id: lesson.id as string,
          order_index: selected.length,
          price_usdc: price,
          title: lesson.title as string,
          slug: lesson.slug as string,
          reason: generateReason(lesson, goal, topics || []),
          expected_value: `Learn ${lesson.title as string}`,
        });
        remaining -= price;
      }
    }

    const estimatedTotal = selected.reduce(
      (sum, l) => sum + (l.price_usdc as number),
      0
    );

    return {
      publishedLessons: lessons,
      unlockedLessonIds: unlockedIds,
      selectedLessons: selected,
      estimatedTotalUsdc: estimatedTotal,
      remainingUsdc: budget - estimatedTotal,
      plannerNotes: [
        `Route: ${config.label} (max ${maxLessons} lessons)`,
        `Selected ${selected.length} of ${available.length} available lessons`,
        `Total: ${estimatedTotal.toFixed(6)} USDC of ${budget} budget`,
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Curriculum planning failed: ${msg}` };
  }
}

function generateReason(
  lesson: Record<string, unknown>,
  goal: string,
  topics: string[]
): string {
  const source = lesson.source as Record<string, unknown> | undefined;
  const sourceName = (source?.source_title as string) || "verified source";
  const tags = (lesson.tags as string[]) || [];

  const topicMatch = topics.find((t) =>
    tags.some((tag) => tag.toLowerCase().includes(t))
  );

  if (topicMatch) {
    return `Directly covers ${topicMatch} from ${sourceName}`;
  }
  if (tags.length > 0) {
    return `Covers ${tags[0]} — relevant background for your goal`;
  }
  return `Source-backed lesson from ${sourceName} — foundational for your learning path`;
}
