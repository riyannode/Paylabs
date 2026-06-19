/**
 * Agent 2: Source Planner Agent (LLM-powered)
 * Selects feed items from RSSHub routes into an ordered source path.
 * No payment, no Runner — read-only planning.
 *
 * Calls actual LLM via invokeJsonAgent with route-specific prompt.
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const SourcePlannerSchema = z.object({
  selected_sources: z.array(
    z.object({
      feed_item_id: z.string().describe("The feed item ID to include"),
      order_index: z.number().describe("Order in the source path (0-indexed)"),
      reason: z.string().describe("Why this feed item was selected"),
      expected_value: z.string().describe("What value the user gets from this source"),
    })
  ).describe("Selected feed items for the source path"),
  estimated_total_usdc: z.number().describe("Estimated total cost in USDC"),
  notes: z.array(z.string()).describe("Planning notes"),
});

type SourcePlannerResult = z.infer<typeof SourcePlannerSchema>;

// ─── Main agent ─────────────────────────────────────────────────

export async function sourcePlannerAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { goal, budgetUsdc, topics, availableFeedItems, paidSourceIds, routeTier, routePrompts, routeConfig } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = routeConfig || getRouteConfig(tier);
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  // Filter out already-paid feed items
  const paidSet = new Set(paidSourceIds || []);
  const candidateItems = (availableFeedItems as Record<string, unknown>[] || []).filter(
    (item) => !paidSet.has(item.id as string)
  );

  if (candidateItems.length === 0) {
    return {
      selectedSources: [],
      estimatedTotalUsdc: 0,
      remainingUsdc: budgetUsdc || 0,
      plannerNotes: ["No available feed items to select from"],
    };
  }

  // Prepare safe metadata for LLM
  const feedMeta = candidateItems.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    route_title: (item.rsshub_route as Record<string, unknown> | undefined)?.route_title,
    route_path: (item.rsshub_route as Record<string, unknown> | undefined)?.route_path,
    published_at: item.published_at,
    content_sha256: item.content_sha256,
  }));

  // Call LLM
  const llmResult = await invokeJsonAgent<SourcePlannerResult>({
    agentName: "source_planner",
    routeTier: tier,
    prompt: prompts.sourcePlanner,
    userMessage: `Goal: "${goal}"\nTopics: ${JSON.stringify(topics || [])}\nBudget: ${budgetUsdc || 0} USDC\nMax sources: ${config.maxSourceCards}\nRoute tier: ${tier}\n\nAvailable feed items (JSON):\n${JSON.stringify(feedMeta, null, 2)}\n\nSelect the best feed items for this goal. Stay within budget. Prefer items with valid content hashes and recent publication dates. Return structured JSON only.`,
    schema: SourcePlannerSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    return {
      error: `Source Planner LLM failed: ${errResult.error}`,
      plannerNotes: ["LLM call failed"],
      llmErrors: { source_planner: errResult },
      agentTrace: { source_planner: errResult.meta },
    };
  }

  const data = (llmResult as { ok: true; data: SourcePlannerResult; meta: Record<string, unknown> }).data;
  const meta = (llmResult as { ok: true; data: SourcePlannerResult; meta: Record<string, unknown> }).meta;

  // Build lookup map for validation
  const itemMap = new Map<string, Record<string, unknown>>();
  for (const item of candidateItems) {
    itemMap.set(item.id as string, item);
  }

  // Validate selected sources exist in candidates
  const validSelections = data.selected_sources.filter((s) => itemMap.has(s.feed_item_id));

  // Cap at maxSourceCards
  const cappedSelections = validSelections.slice(0, Number(config.maxSourceCards));

  const estimatedTotal = data.estimated_total_usdc;
  const remaining = (budgetUsdc || 0) - estimatedTotal;

  return {
    selectedSources: cappedSelections,
    estimatedTotalUsdc: estimatedTotal,
    remainingUsdc: remaining,
    plannerNotes: data.notes,
    agentTrace: { source_planner: meta },
    llmOutputs: { source_planner: data },
  };
}
