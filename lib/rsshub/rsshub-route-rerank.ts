/**
 * RSSHub Route LLM Rerank
 *
 * Optional LLM reranking of deterministic route candidates.
 * LLM may ONLY select from the provided candidate set — it cannot invent routes.
 * Controller validates every selected route exists in the candidate set.
 *
 * Enabled via: PAYLABS_RSSHUB_LLM_ROUTE_RERANK=true
 *
 * No raw secret/log output. No direct URL fetching by LLM.
 */

import { z } from "zod";
import type { RsshubRouteCandidate } from "./rsshub-route-search";

// ─── Schema ────────────────────────────────────────────────

const RouteRerankSchema = z.object({
  selected_route_paths: z.array(z.string()),
  reason: z.string(),
});

// ─── Public API ────────────────────────────────────────────

export interface RouteRerankResult {
  ok: boolean;
  selectedCandidates: RsshubRouteCandidate[];
  reason: string;
  error?: string;
}

/**
 * LLM rerank of route candidates.
 * The LLM may only return fullPath values from the candidate set.
 * Any path not in the candidate set is dropped.
 *
 * @param candidates - deterministic route candidates from searchRsshubRoutes
 * @param userGoal - original user goal
 * @param expandedQueries - query variants
 * @param entityTerms - entity terms
 * @param routeTier - route tier for LLM config
 * @param maxRoutes - max routes to select
 */
export async function rerankRouteCandidates(input: {
  candidates: RsshubRouteCandidate[];
  userGoal: string;
  expandedQueries: string[];
  entityTerms: string[];
  routeTier: string;
  maxRoutes: number;
}): Promise<RouteRerankResult> {
  const {
    candidates,
    userGoal,
    expandedQueries,
    entityTerms,
    routeTier,
    maxRoutes,
  } = input;

  if (candidates.length === 0) {
    return { ok: true, selectedCandidates: [], reason: "No candidates to rerank" };
  }

  try {
    const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
    const { toInternalRouteTier } = await import(
      "@/lib/paylabs/agent-services/handlers/helpers"
    );

    // Build candidate catalog for LLM (safe metadata only)
    const candidateCatalog = candidates.map((c) => ({
      fullPath: c.route.fullPath,
      name: c.route.name,
      namespace: c.route.namespace,
      description: (c.route.description || "").slice(0, 200),
      heat: c.route.heat,
      score: c.score,
      matchedTerms: c.matchedTerms,
      reason: c.reason,
    }));

    const SYSTEM_PROMPT = `You are a route selector for RSSHub feed discovery.
Your task is to select the most relevant RSSHub routes from a pre-computed candidate list.

RULES:
- You may ONLY select routes whose fullPath appears in the candidate list below.
- NEVER invent new routes or paths.
- NEVER modify paths.
- Select at most ${maxRoutes} routes.
- Prioritize routes that best match the user's actual question.
- Prefer routes with higher deterministic scores and entity matches.
- If no route is relevant, return selected_route_paths: [].

Return JSON only. No markdown. No commentary.`;

    const userPrompt = `User goal: ${userGoal}
Expanded queries: ${JSON.stringify(expandedQueries)}
Entity terms: ${JSON.stringify(entityTerms)}

Candidate routes (from real RSSHub catalog):
${JSON.stringify(candidateCatalog, null, 2)}

Select the most relevant routes. Return JSON only.`;

    const result = await generateStructuredJson<
      z.infer<typeof RouteRerankSchema>
    >({
      agentName: "signal_scout",
      routeTier: toInternalRouteTier(
        routeTier as "easy" | "normal" | "advanced"
      ),
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: RouteRerankSchema,
    });

    if (!result.ok) {
      // Fallback: use top deterministic candidates
      return {
        ok: true,
        selectedCandidates: candidates.slice(0, maxRoutes),
        reason: "LLM rerank failed, using deterministic ranking",
      };
    }

    // Validate: every selected path must exist in candidate set
    const candidateMap = new Map(
      candidates.map((c) => [c.route.fullPath, c])
    );
    const selectedPaths = result.data.selected_route_paths || [];
    const validated: RsshubRouteCandidate[] = [];

    for (const path of selectedPaths) {
      const candidate = candidateMap.get(path);
      if (candidate) {
        validated.push(candidate);
      }
      // Drop paths not in candidate set — silently
    }

    return {
      ok: true,
      selectedCandidates: validated.slice(0, maxRoutes),
      reason: result.data.reason || "LLM rerank",
    };
  } catch (err: unknown) {
    // Fallback: use top deterministic candidates
    return {
      ok: true,
      selectedCandidates: candidates.slice(0, maxRoutes),
      reason: `LLM rerank error: ${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`,
    };
  }
}
