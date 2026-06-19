/**
 * Agent 2: Source Planner Agent (LLM-powered)
 * Selects feed items from RSSHub routes into an ordered source path.
 * No payment, no Runner — read-only planning.
 *
 * Calls actual LLM via invokeJsonAgent with route-specific prompt.
 *
 * Safety rules:
 * - Loads feed items directly from DB (never trusts state.availableFeedItems)
 * - LLM can only output: feed_item_id, reason, expected_value
 * - Backend computes total from price_per_citation_usdc (never from LLM)
 * - Backend enforces budget and maxSourceCards
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { listFeedItems } from "./tools";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────
// LLM can ONLY output feed_item_id, reason, expected_value.
// No price, no wallet, no source URL, no total.

const SourcePlannerSchema = z.object({
  selected_sources: z.array(
    z.object({
      feed_item_id: z.string().describe("The feed item ID to include"),
      order_index: z.number().describe("Order in the source path (0-indexed)"),
      reason: z.string().describe("Why this feed item was selected"),
      expected_value: z.string().describe("What value the user gets from this source"),
    })
  ).describe("Selected feed items for the source path"),
  notes: z.array(z.string()).describe("Planning notes"),
});

type SourcePlannerResult = z.infer<typeof SourcePlannerSchema>;

// ─── Main agent ─────────────────────────────────────────────────

export async function sourcePlannerAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { goal, budgetUsdc, topics, routeTier, routePrompts, routeConfig } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = routeConfig || getRouteConfig(tier);
  const prompts = (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) || getPromptsForRoute(tier);

  // ── Load feed items directly from DB — never trust state ──
  let allFeedItems: Record<string, unknown>[];
  try {
    allFeedItems = (await listFeedItems()) as Record<string, unknown>[];
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      selectedSources: [],
      estimatedTotalUsdc: 0,
      remainingUsdc: budgetUsdc || 0,
      // plannerNotes removed — use error field
      error: `Source Planner DB read failed: ${msg}`,
    };
  }

  // Filter out already-paid feed items
  const paidSet = new Set<string>(); // paidSourceIds removed from state
  const candidateItems = allFeedItems.filter(
    (item) => !paidSet.has(item.id as string)
  );

  if (candidateItems.length === 0) {
    return {
      selectedSources: [],
      estimatedTotalUsdc: 0,
      remainingUsdc: budgetUsdc || 0,
      // plannerNotes removed: ["No available feed items to select from"],
    };
  }

  // Prepare safe metadata for LLM — no price, no wallet, no source URL
  const feedMeta = candidateItems.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    route_title: (item.rsshub_route as Record<string, unknown> | undefined)?.title,
    route_path: (item.rsshub_route as Record<string, unknown> | undefined)?.route_path,
    published_at: item.published_at,
    content_sha256: item.content_sha256,
    author_name: item.author_name,
    publisher: item.publisher,
  }));

  // Call LLM
  const llmResult = await invokeJsonAgent<SourcePlannerResult>({
    agentName: "source_planner",
    routeTier: tier,
    prompt: prompts.sourcePlanner,
    userMessage: `Goal: "${goal}"\nTopics: ${JSON.stringify(topics || [])}\nBudget: ${budgetUsdc || 0} USDC\nMax sources: ${config.maxSourceCards}\nRoute tier: ${tier}\n\nAvailable feed items (JSON):\n${JSON.stringify(feedMeta, null, 2)}\n\nSelect the best feed items for this goal. Return structured JSON only.`,
    schema: SourcePlannerSchema,
  });

  if (!llmResult.ok) {
    const errResult = llmResult as { ok: false; error: string; meta: Record<string, unknown> };
    return {
      error: `Source Planner LLM failed: ${errResult.error}`,
      // plannerNotes removed: ["LLM call failed"],
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

  // ── Compute total from DB prices — NEVER from LLM ──
  let computedTotal = 0;
  for (const sel of cappedSelections) {
    const feedItem = itemMap.get(sel.feed_item_id);
    if (feedItem) {
      computedTotal += Number((feedItem.price_per_citation_usdc as number) || 0);
    }
  }

  const remaining = (budgetUsdc || 0) - computedTotal;

  // Enforce budget
  if (computedTotal > (budgetUsdc || 0)) {
    return {
      selectedSources: [],
      estimatedTotalUsdc: computedTotal,
      remainingUsdc: remaining,
      // plannerNotes removed: [`Computed total ${computedTotal} USDC exceeds budget ${budgetUsdc || 0} USDC`],
      agentTrace: { source_planner: meta },
    };
  }

  return {
    selectedSources: cappedSelections,
    estimatedTotalUsdc: computedTotal,
    remainingUsdc: remaining,
    // plannerNotes removed: data.notes,
    agentTrace: { source_planner: meta },
    llmOutputs: { source_planner: data },
  };
}
