/**
 * Query Builder Handler
 *
 * Reuses: query_expander
 * Macro-node: discovery_planner
 * Requires LLM: yes
 *
 * Expands normalized goal into source discovery queries.
 */

import { z } from "zod";
import { generateStructuredJson } from "@/lib/ai/llm-structured";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import { toInternalRouteTier } from "./helpers";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

const QueryBuilderSchema = z.object({
  expanded_queries: z.array(z.string()),
  entity_terms: z.array(z.string()),
  negative_filters: z.array(z.string()),
  source_preferences: z.array(z.string()),
  safe_summary: z.string(),
});

const SYSTEM_PROMPT = `You are PayLabs Query Builder. Expand the normalized goal into precise source discovery queries. Focus on source paths, attribution, payment, creator monetization, RSSHub, x402, Circle, Arc, and AI agent commerce when relevant. You cannot pick final sources, set payment values, hallucinate URLs, or execute payments. Return structured JSON only. Always include a safe_summary field.`;

export const queryBuilderHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { normalized_goal, topics, routeTier } = input.payload as {
    normalized_goal: string;
    topics: string[];
    routeTier?: DelegatedRouteTier;
  };

  const result = await generateStructuredJson<z.infer<typeof QueryBuilderSchema>>({
    agentName: "query_builder",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal || ""}"\nTopics: ${JSON.stringify(topics || [])}\nRoute: ${routeTier || "easy"}`,
    schema: QueryBuilderSchema,
  });

  if (!result.ok) {
    return {
      ok: false,
      serviceName: "query_builder",
      data: null,
      safeSummary: `Query builder failed: ${result.error}`,
      settled: false,
      error: result.error,
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
