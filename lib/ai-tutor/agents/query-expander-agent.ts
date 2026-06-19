/**
 * Agent 3: Query Expander
 * Expand normalized goal into source discovery queries.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";

const Schema = z.object({
  expanded_queries: z.array(z.string()),
  required_concepts: z.array(z.string()),
  optional_concepts: z.array(z.string()),
  exclusion_terms: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Query Expander Agent. Expand the normalized goal into precise source discovery queries. Focus on source paths, attribution, payment, creator monetization, RSSHub, x402, Circle, Arc, and AI agent commerce when relevant. You cannot pick final sources. You cannot set payment values. You cannot hallucinate URLs. You cannot execute payments. Return structured JSON only.`;

export async function queryExpanderAgent(state: PayLabsTutorStateType) {
  const { normalizedGoal, goal, topics, routeTier } = state;
  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "query_expander",
    routeTier: routeTier || "normal",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalizedGoal || goal || ""}"\nTopics: ${JSON.stringify(topics || [])}\nRoute: ${routeTier || "normal"}`,
    schema: Schema,
  });
  if (!result.ok) return { error: `Query expander failed: ${result.error}`, llmErrors: { query_expander: result } };
  return {
    expandedQueries: result.data.expanded_queries,
    requiredConcepts: result.data.required_concepts,
    optionalConcepts: result.data.optional_concepts,
    agentTrace: { query_expander: result.meta },
    llmOutputs: { query_expander: result.data },
    agentCallCounts: { query_expander: 1 },
  };
}
