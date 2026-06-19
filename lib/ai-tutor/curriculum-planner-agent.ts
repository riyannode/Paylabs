/**
 * Agent 2: Curriculum Planner Agent
 * Picks source-backed lessons that fit the goal and budget.
 * No payment, no Runner — read-only.
 *
 * Uses LLM (ChatOpenAI + structured output) when available.
 * Server always re-validates: IDs exist, not unlocked, budget, max price, max count.
 * Falls back to deterministic scoring if no API key or LLM fails.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { getTutorModel, getTutorModelName } from "./llm";
import { listPublishedLessons, getUserUnlocks } from "./tools";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createHash } from "node:crypto";

// ─── Zod schema for LLM structured output ───────────────────────

const PlannerSchema = z.object({
  selected_lessons: z.array(
    z.object({
      lesson_id: z.string().describe("The lesson ID to include in the path"),
      reason: z.string().describe("Why this lesson was selected for the user's goal"),
      expected_value: z.string().describe("What the user will learn from this lesson"),
    })
  ).describe("Selected lessons for the learning path, ordered"),
});

type PlannerResult = z.infer<typeof PlannerSchema>;

// ─── Safe lesson metadata for LLM (no secrets, no internal IDs beyond lesson_id) ──

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

// ─── LLM path ───────────────────────────────────────────────────

async function runPlannerLLM(
  goal: string,
  budgetUsdc: number,
  tier: RouteTier,
  maxLessons: number,
  safeLessons: Record<string, unknown>[],
  prompt: string
): Promise<PlannerResult | null> {
  const model = getTutorModel();
  if (!model) return null;

  try {
    const structuredModel = model.withStructuredOutput(PlannerSchema);

    const result = await structuredModel.invoke([
      new SystemMessage(prompt),
      new HumanMessage(
        `User goal: "${goal}"\nBudget: ${budgetUsdc} USDC\nRoute tier: ${tier}\nMax lessons: ${maxLessons}\n\nAvailable lessons (JSON):\n${JSON.stringify(safeLessons, null, 2)}\n\nSelect up to ${maxLessons} lessons that best fit the goal and budget.`
      ),
    ]);

    return result as PlannerResult;
  } catch {
    return null;
  }
}

// ─── Server re-validation ───────────────────────────────────────

function revalidateSelection(
  llmSelection: PlannerResult,
  available: Record<string, unknown>[],
  unlockedIds: string[],
  budget: number,
  maxPrice: number,
  maxLessons: number,
  goal: string,
  topics: string[]
): { selected: Record<string, unknown>[]; rejected: string[] } {
  const selected: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  let remaining = budget;

  for (const item of llmSelection.selected_lessons) {
    // Check max count
    if (selected.length >= maxLessons) {
      rejected.push(`${item.lesson_id}: max lessons reached`);
      continue;
    }

    // Check lesson exists in available
    const lesson = available.find((l) => l.id === item.lesson_id);
    if (!lesson) {
      rejected.push(`${item.lesson_id}: not found in available lessons`);
      continue;
    }

    // Check not unlocked
    if (unlockedIds.includes(item.lesson_id)) {
      rejected.push(`${item.lesson_id}: already unlocked`);
      continue;
    }

    // Check price
    const price = Number(lesson.price_usdc) || 0;
    if (price > maxPrice) {
      rejected.push(`${item.lesson_id}: price ${price} exceeds max ${maxPrice}`);
      continue;
    }

    // Check budget
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

// ─── Deterministic fallback (existing scoring logic) ────────────

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

  for (const topic of topics) {
    if (text.includes(topic)) score += 3;
  }
  for (const word of goal.split(/\s+/)) {
    if (word.length > 2 && text.includes(word)) score += 2;
  }

  const source = lesson.source as Record<string, unknown> | undefined;
  if (source?.normalized_sha256) score += 2;
  if (lesson.content_sha256) score += 1;

  const creator = lesson.creator as Record<string, unknown> | undefined;
  if (creator?.is_verified) score += 1;

  const price = Number(lesson.price_usdc) || 1;
  score += (1 / price) * 0.001;

  return score;
}

function runPlannerDeterministic(
  available: Record<string, unknown>[],
  topics: string[],
  goal: string,
  budget: number,
  maxPrice: number,
  maxLessons: number
): { selected: Record<string, unknown>[] } {
  const scored: (Record<string, unknown> & { _score: number })[] = available.map((l) => ({
    ...l,
    _score: scoreLesson(l, topics || [], goal),
  }));
  scored.sort((a, b) => b._score - a._score);

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

  return { selected };
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
  const maxLessons = config.maxLessons;
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  try {
    const lessons = (await listPublishedLessons()) as Record<string, unknown>[];
    const unlockedIds = await getUserUnlocks(userWallet);

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

    let selected: Record<string, unknown>[] = [];
    let mode: "llm" | "deterministic_fallback" = "llm";
    let llmRejected: string[] = [];

    // Try LLM path
    const safeLessons = buildSafeLessonMetadata(available, unlockedIds);
    const llmResult = await runPlannerLLM(
      goal, budget, tier, maxLessons, safeLessons, prompts.curriculumPlanner
    );

    if (llmResult) {
      // Server re-validates LLM output
      const validated = revalidateSelection(
        llmResult, available, unlockedIds, budget, maxPrice, maxLessons, goal, topics || []
      );
      selected = validated.selected;
      llmRejected = validated.rejected;
    } else {
      // Deterministic fallback
      mode = "deterministic_fallback";
      const det = runPlannerDeterministic(available, topics || [], goal, budget, maxPrice, maxLessons);
      selected = det.selected;
    }

    const estimatedTotal = selected.reduce(
      (sum, l) => sum + (l.price_usdc as number), 0
    );

    const promptText = prompts.curriculumPlanner;
    const promptHash = createHash("sha256").update(promptText).digest("hex").slice(0, 16);

    const plannerNotes: string[] = [
      `Route: ${config.label} (max ${maxLessons} lessons)`,
      `Mode: ${mode}`,
      `Selected ${selected.length} of ${available.length} available lessons`,
      `Total: ${estimatedTotal.toFixed(6)} USDC of ${budget} budget`,
    ];
    if (llmRejected.length > 0) {
      plannerNotes.push(`LLM selections rejected by server: ${llmRejected.join("; ")}`);
    }

    return {
      publishedLessons: lessons,
      unlockedLessonIds: unlockedIds,
      selectedLessons: selected,
      estimatedTotalUsdc: estimatedTotal,
      remainingUsdc: budget - estimatedTotal,
      plannerNotes,
      agentTrace: {
        curriculum_planner: {
          agent: "curriculum_planner_agent",
          mode,
          route_tier: tier,
          prompt_persona: `${tier}_curriculum_planner`,
          prompt_hash: promptHash,
          planner_style: config.plannerStyle,
          max_lessons: maxLessons,
          selected_count: selected.length,
          ...(mode === "llm" ? { model: getTutorModelName(), llm_rejected_count: llmRejected.length } : {}),
        },
      },
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

  if (topicMatch) return `Directly covers ${topicMatch} from ${sourceName}`;
  if (tags.length > 0) return `Covers ${tags[0]} — relevant background for your goal`;
  return `Source-backed lesson from ${sourceName} — foundational for your learning path`;
}
