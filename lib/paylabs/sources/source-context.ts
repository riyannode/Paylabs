/**
 * Source Context Builder
 *
 * Builds the user-facing SourceContext from OrchestratorOutput.
 * Extracts ranked candidates from signal_scout service evaluations
 * and enriches them via source-resolver.
 *
 * Safe fields only — no raw RSS payloads, no x402 data, no secrets.
 */

import type { OrchestratorOutput } from "../delegated-runtime/types";
import type { SourceContext } from "./types";
import { resolveSources } from "./source-resolver";

/**
 * Build SourceContext from orchestrator result.
 * Extracts ranked candidates from signal_scout evaluation + brain intent,
 * then enriches via source-resolver.
 *
 * Returns null if no candidates found (easy tier may have none).
 */
export async function buildSourceContextFromResult(
  result: OrchestratorOutput
): Promise<SourceContext | null> {
  // Extract ranked candidates from signal_scout or signal_scout_basics evaluation
  const signalEval = result.serviceEvaluations.find(
    (e) => (e.serviceName === "signal_scout" || e.serviceName === "signal_scout_basics") && e.output
  );
  if (!signalEval?.output) return null;

  const signalData = signalEval.output as {
    ranked_candidates?: Array<{
      feed_item_id: string;
      rank: number;
      relevance_score: number;
    }>;
    retrieval_mode?: string;
    source_strategy?: string;
    topic_routes_count?: number;
    topic_candidates_count?: number;
  };

  const rankedCandidates = signalData.ranked_candidates;
  if (!rankedCandidates || rankedCandidates.length === 0) return null;

  // Extract retrieval_mode from signal_scout output
  const retrievalMode = signalData.retrieval_mode as
    | "rsshub_live"
    | "db_fallback"
    | "rsshub_live_empty"
    | undefined;

  // Extract brain intent context
  const normalizedGoal =
    result.brainPlanning?.normalized_goal || "";
  const intentType = extractIntentType(result);
  const constraints = extractConstraints(result);

  // Extract entity_terms from query_builder evaluation (Fix: non-x402 path entity propagation)
  const entityTerms = extractEntityTerms(result);

  const resolverResult = await resolveSources({
    rankedCandidates,
    normalizedGoal,
    intentType,
    constraints,
    entityTerms,
  });

  if (!resolverResult.ok) return null;

  // Propagate retrieval_mode from signal_scout
  return {
    ...resolverResult.sourceContext,
    retrieval_mode: retrievalMode || inferRetrievalMode(resolverResult.sourceContext),
    source_strategy: signalData.source_strategy,
    topic_routes_count: signalData.topic_routes_count,
    topic_candidates_count: signalData.topic_candidates_count,
  };
}

/**
 * Infer retrieval_mode from source context when signal_scout doesn't provide it.
 */
function inferRetrievalMode(
  ctx: SourceContext
): "rsshub_live" | "db_fallback" | "rsshub_live_empty" {
  if (ctx.sources_used.length === 0) return "rsshub_live_empty";
  const hasLive = ctx.sources_used.some((s) => s.source_kind === "rsshub_live");
  return hasLive ? "rsshub_live" : "db_fallback";
}

// ─── Helpers ──────────────────────────────────────────────

function extractIntentType(result: OrchestratorOutput): string | undefined {
  const intentEval = result.serviceEvaluations.find(
    (e) => e.serviceName === "intent_planner" && e.output
  );
  if (!intentEval?.output) return undefined;
  return (intentEval.output as { intent_type?: string }).intent_type;
}

function extractConstraints(result: OrchestratorOutput): string[] {
  const intentEval = result.serviceEvaluations.find(
    (e) => e.serviceName === "intent_planner" && e.output
  );
  if (!intentEval?.output) return [];
  return ((intentEval.output as { constraints?: string[] }).constraints) || [];
}

function extractEntityTerms(result: OrchestratorOutput): string[] {
  // Try query_builder evaluation first
  const qbEval = result.serviceEvaluations.find(
    (e) => e.serviceName === "query_builder" && e.output
  );
  if (qbEval?.output) {
    const data = qbEval.output as Record<string, unknown>;
    const terms = (data.entity_terms as string[]) || (data.entityTerms as string[]) || [];
    if (terms.length > 0) return terms;
  }
  // Fallback: try brainPlanning
  const brainTerms = (result.brainPlanning as unknown as Record<string, unknown>);
  if (brainTerms) {
    const terms = (brainTerms.entity_terms as string[]) || (brainTerms.entityTerms as string[]) || [];
    if (terms.length > 0) return terms;
  }
  return [];
}
