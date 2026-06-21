/**
 * Query Builder Handler
 *
 * Reuses: query_expander
 * Macro-node: discovery_planner
 * Execution modes:
 *   - deterministic (default): deterministic query expansion from goal + topics
 *   - llm: LLM-powered query expansion
 *   - hybrid: deterministic + LLM enrichment
 *
 * Expands normalized goal into source discovery queries.
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

const QueryBuilderSchema = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  negative_filters: z.array(z.string()),
  source_preferences: z.array(z.string()),
  safe_summary: z.string(),
});

// ─── Deterministic Query Expansion ──────────────────────────

function runDeterministicQueryBuilder(
  normalizedGoal: string,
  topics: string[]
): {
  expanded_queries: string[];
  entity_terms: string[];
  negative_filters: string[];
  source_preferences: string[];
} {
  const goal = normalizedGoal.trim().toLowerCase();

  // Extract entity terms: capitalized words, quoted phrases, and topics
  const entityTerms: string[] = [...topics];
  const quotedPhrases = normalizedGoal.match(/"([^"]+)"/g)?.map((p) => p.replace(/"/g, "")) || [];
  entityTerms.push(...quotedPhrases);

  // Build expanded queries from goal
  const expandedQueries: string[] = [normalizedGoal];

  // Add topic-based variants
  for (const topic of topics.slice(0, 3)) {
    expandedQueries.push(`${normalizedGoal} ${topic}`);
  }

  // Add domain-specific variants
  const domainTerms = ["source", "article", "paper", "data", "report"];
  const lowerGoal = normalizedGoal.toLowerCase();
  for (const term of domainTerms) {
    if (!lowerGoal.includes(term)) {
      expandedQueries.push(`${normalizedGoal} ${term}`);
      break; // only add one domain variant
    }
  }

  // Negative filters: common noise terms
  const negativeFilters: string[] = [];
  if (!goal.includes("ad") && !goal.includes("advertisement")) {
    negativeFilters.push("advertisement", "sponsored");
  }
  if (!goal.includes("paywall")) {
    negativeFilters.push("paywall");
  }

  // Source preferences based on topics
  const sourcePreferences: string[] = [];
  if (topics.some((t) => t.includes("research") || t.includes("academic"))) {
    sourcePreferences.push("academic", "peer-reviewed");
  }
  if (topics.some((t) => t.includes("news") || t.includes("current"))) {
    sourcePreferences.push("recent", "verified");
  }
  if (sourcePreferences.length === 0) {
    sourcePreferences.push("credible", "recent");
  }

  return {
    expanded_queries: expandedQueries.slice(0, 5),
    entity_terms: [...new Set(entityTerms)].slice(0, 10),
    negative_filters: negativeFilters,
    source_preferences: sourcePreferences,
  };
}

// ─── Handler ────────────────────────────────────────────────

export const queryBuilderHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { normalized_goal, topics, routeTier } = input.payload as {
    normalized_goal: string;
    topics: string[];
    routeTier?: DelegatedRouteTier;
  };

  // Deterministic mode (default)
  if (shouldRunServiceAsDeterministic("query_builder")) {
    const det = runDeterministicQueryBuilder(normalized_goal || "", topics || []);
    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        expanded_queries: det.expanded_queries,
        entity_terms: det.entity_terms,
        negative_filters: det.negative_filters,
        source_preferences: det.source_preferences,
        safe_query_summary: `Built ${det.expanded_queries.length} queries, ${det.entity_terms.length} entities, ${det.negative_filters.length} filters. Deterministic expansion.`,
      },
      safeSummary: `Built ${det.expanded_queries.length} queries, ${det.entity_terms.length} entities, ${det.negative_filters.length} filters. Deterministic expansion.`,
      settled: false,
      error: null,
    };
  }

  // LLM mode
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `You are PayLabs Query Builder. Expand the normalized goal into precise source discovery queries. Focus on source paths, attribution, payment, creator monetization, RSSHub, x402, Circle, Arc, and AI agent commerce when relevant. You cannot pick final sources, set payment values, hallucinate URLs, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

  const result = await generateStructuredJson<z.infer<typeof QueryBuilderSchema>>({
    agentName: "query_builder",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal || ""}"\nTopics: ${JSON.stringify(topics || [])}\nRoute: ${routeTier || "easy"}`,
    schema: QueryBuilderSchema,
  });

  if (!result.ok) {
    // Fallback: deterministic
    const det = runDeterministicQueryBuilder(normalized_goal || "", topics || []);
    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        expanded_queries: det.expanded_queries,
        entity_terms: det.entity_terms,
        negative_filters: det.negative_filters,
        source_preferences: det.source_preferences,
        safe_query_summary: `Built ${det.expanded_queries.length} queries (LLM failed, deterministic fallback).`,
      },
      safeSummary: `Built ${det.expanded_queries.length} queries (LLM failed, deterministic fallback).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "query_builder",
    data: {
      expanded_queries: result.data.expanded_queries,
      entity_terms: result.data.entity_terms,
      negative_filters: result.data.negative_filters,
      source_preferences: result.data.source_preferences,
      safe_query_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
