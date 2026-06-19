/**
 * Agent 2: Curriculum Planner Agent (LLM-powered)
 * Picks source-backed lessons that fit the goal and budget.
 * No payment, no Runner — read-only.
 *
 * Calls actual LLM via invokeJsonAgent with route-specific prompt.
 * Server always re-validates: IDs exist, not unlocked, budget, max price, max count.
 * Server recomputes price — never trust LLM price.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { listPublishedLessons, getUserUnlocks } from "./tools";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const PlannerSchema = z.object({
  selected_lessons: z.array(
    z.object({
      lesson_id: z.string().describe("The lesson ID to include in the path"),
      reason: z.string().describe("Why this lesson was selected for the user's goal"),
      expected_value: z.string().describe("What the user will learn from this lesson"),
    })
  ).describe("Selected lessons for the learning path, ordered"),
  planner_notes: z.array(z.string()).describe("Notes about the planning decisions"),
});

type PlannerResult = z.infer<typeof PlannerSchema>;

// ─── Safe lesson metadata for LLM ───────────────────────────────

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

// ─── Server re-validation ───────────────────────────────────────

function revalidateSelection(
  llmSelection: PlannerResult,
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
  const maxLessons = config.maxLessons;
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  try {
    const lessons = (await listPublishedLessons()) as Record<string, unknown>[];
    const unlockedIds = await getUserUnlocks(userWallet);
    const available = lessons.filter((l) => !unlockedIds.includes(l.id as string));

    if (available.length === 0) {
      return {
        error: "No available lessons",
        selectedLessons: [],
        plannerNotes: ["No published lessons available after excluding unlocked"],
      };
    }

    const safeLessons = buildSafeLessonMetadata(available, unlockedIds);

    // Call LLM
    const llmResult = await invokeJsonAgent<PlannerResult>({
      agentName: "curriculum_planner",
      routeTier: tier,
      prompt: prompts.curriculumPlanner,
      userMessage: `User goal: "${goal}"\nTopics: ${(topics || []).join(", ")}\nBudget: ${budget} USDC\nRoute tier: ${tier}\nMax lessons: ${maxLessons}\nMax lesson price: ${maxPrice} USDC\n\nAvailable lessons (JSON):\n${JSON.stringify(safeLessons, null, 2)}\n\nSelect up to ${maxLessons} lessons that best fit the goal and budget.`,
      schema: PlannerSchema,
    });

    if (!llmResult.ok) {
      const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
      return {
        error: `Curriculum Planner LLM failed: ${errResult.error}`,
        llmErrors: { curriculum_planner: errResult },
        agentTrace: { curriculum_planner: errResult.meta },
      };
    }

    const data = (llmResult as { ok: true; data: PlannerResult; meta: Record<string, unknown> }).data;
    const meta = (llmResult as { ok: true; data: PlannerResult; meta: Record<string, unknown> }).meta;

    // Server re-validates LLM output — NEVER trust LLM for prices/IDs
    const validated = revalidateSelection(data, available, unlockedIds, budget, maxPrice, maxLessons);

    const estimatedTotal = validated.selected.reduce(
      (sum, l) => sum + (l.price_usdc as number), 0
    );

    const plannerNotes: string[] = [
      `Route: ${config.label} (max ${maxLessons} lessons)`,
      `LLM selected ${data.selected_lessons.length}, server validated ${validated.selected.length}`,
      `Total: ${estimatedTotal.toFixed(6)} USDC of ${budget} budget`,
      ...data.planner_notes,
    ];
    if (validated.rejected.length > 0) {
      plannerNotes.push(`Server rejected: ${validated.rejected.join("; ")}`);
    }

    return {
      publishedLessons: lessons,
      unlockedLessonIds: unlockedIds,
      selectedLessons: validated.selected,
      estimatedTotalUsdc: estimatedTotal,
      remainingUsdc: budget - estimatedTotal,
      plannerNotes,
      agentTrace: { curriculum_planner: meta },
      llmOutputs: { curriculum_planner: data },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Curriculum planning failed: ${msg}` };
  }
}
