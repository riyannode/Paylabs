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
  const { normalized_goal, topics, routeTier, brain_query_variants, brain_discovery_strategy, brain_normalized_goal } = input.payload as {
    normalized_goal: string;
    topics: string[];
    routeTier?: DelegatedRouteTier;
    brain_query_variants?: string[];
    brain_discovery_strategy?: string;
    brain_normalized_goal?: string;
  };

  // Merge Brain query variants with deterministic expansion as baseline
  const baseGoal = brain_normalized_goal || normalized_goal || "";
  const det = runDeterministicQueryBuilder(baseGoal, topics || []);
  const brainVariants = (brain_query_variants || []).map((q: string) => q.trim()).filter(Boolean);

  // ── Deterministic mode: Brain variants primary, deterministic second ──
  if (shouldRunServiceAsDeterministic("query_builder")) {
    // Merge Brain query variants first, deterministic second
    const merged = [...brainVariants, ...det.expanded_queries];

    // Dedupe case-insensitively, trim, cap to 7
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const q of merged) {
      const key = q.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.push(q.trim());
      }
    }
    const finalQueries = deduped.slice(0, 7);

    // Derive negative_filters and source_preferences from constraints
    const negativeFilters = [...(det.negative_filters || [])];
    const sourcePreferences = [...(det.source_preferences || [])];
    for (const c of topics || []) {
      const cl = c.toLowerCase();
      if (cl === "recency_priority" && !sourcePreferences.includes("recent")) {
        sourcePreferences.push("recent");
      }
      if (cl === "trust_required" && !sourcePreferences.includes("credible")) {
        sourcePreferences.push("credible", "official");
      }
      if (cl === "free_only" && !negativeFilters.includes("paywall")) {
        negativeFilters.push("paywall", "premium");
      }
      if (cl === "quality_priority" && !sourcePreferences.includes("high_quality")) {
        sourcePreferences.push("high_quality", "primary_source");
      }
    }

    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        expanded_queries: finalQueries,
        entity_terms: det.entity_terms,
        negative_filters: negativeFilters,
        source_preferences: sourcePreferences,
        safe_query_summary: `Built ${finalQueries.length} queries${brainVariants.length > 0 ? ` (${brainVariants.length} from Brain)` : ""}, ${det.entity_terms.length} entities, ${negativeFilters.length} filters. Deterministic expansion.`,
      },
      safeSummary: `Built ${finalQueries.length} queries, ${det.entity_terms.length} entities, ${negativeFilters.length} filters. Deterministic expansion.`,
      settled: false,
      error: null,
    };
  }

  // ── LLM mode: use Brain variants as primary input, LLM refines/expands ──
  const { generateStructuredJson } = await import("@/lib/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `You are PayLabs Query Builder.
Your task is to create precise source discovery queries from the normalized goal.
Use only the provided normalized goal, topics, Brain query variants, and route context. Preserve exact names:
project names
protocol names
product names
company names
URLs/domains
version numbers
technical terms
dates
source names (e.g. CoinDesk, TechCrunch)

You may refine or expand the Brain query variants to improve source discovery coverage.
If Brain query variants are provided, use them as your primary input and refine them — do NOT discard them.

Build query variants for source discovery only. Do not choose final sources. Do not invent URLs. Do not invent titles. Do not set prices. Do not choose wallets. Do not execute payments. Do not settle payments.
Query rules:
Prefer exact-match queries over broad generic queries.
Include both entities for comparison tasks.
Include claim-focused wording for verification tasks.
Add recency wording only if the user asks for latest/current/recent/today/this week/2025/2026/new.
Do not return more than 7 expanded_queries.
Avoid duplicate queries.
Avoid generic filler queries.
negative_filters should remove obvious noise only. source_preferences should be short tags such as official, credible, recent, primary_source, technical, documentation.
safe_summary must be 1 short sentence. It must not mention internal chain-of-thought, payment internals, wallets, x402, Gateway, or settlement.
Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{"`;

  const brainVariantsText = brainVariants.length > 0
    ? `\nBrain query variants (use as primary, refine/expand):\n${brainVariants.map((q: string) => `- "${q}"`).join("\n")}`
    : "";

  const result = await generateStructuredJson<z.infer<typeof QueryBuilderSchema>>({
    agentName: "query_builder",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal || ""}"\nTopics: ${JSON.stringify(topics || [])}${brainVariantsText}\nDiscovery strategy: ${brain_discovery_strategy || "none"}\nRoute: ${routeTier || "easy"}`,
    schema: QueryBuilderSchema,
  });

  if (!result.ok) {
    // Fallback: use Brain's LLM-generated variants as primary, deterministic second
    const fallbackMerged = [...brainVariants, ...det.expanded_queries];
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const q of fallbackMerged) {
      const key = q.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.push(q.trim());
      }
    }
    const fallbackQueries = deduped.slice(0, 7);

    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        expanded_queries: fallbackQueries,
        entity_terms: det.entity_terms,
        negative_filters: det.negative_filters,
        source_preferences: det.source_preferences,
        safe_query_summary: `Built ${fallbackQueries.length} queries (LLM failed, ${brainVariants.length > 0 ? "Brain variants + " : ""}deterministic fallback).`,
      },
      safeSummary: `Built ${fallbackQueries.length} queries (LLM failed, ${brainVariants.length > 0 ? "Brain variants + " : ""}deterministic fallback).`,
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
