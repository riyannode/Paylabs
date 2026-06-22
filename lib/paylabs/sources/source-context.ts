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
  // Extract ranked candidates from signal_scout evaluation
  const signalEval = result.serviceEvaluations.find(
    (e) => e.serviceName === "signal_scout" && e.output
  );
  if (!signalEval?.output) return null;

  const signalData = signalEval.output as {
    ranked_candidates?: Array<{
      feed_item_id: string;
      rank: number;
      relevance_score: number;
    }>;
  };

  const rankedCandidates = signalData.ranked_candidates;
  if (!rankedCandidates || rankedCandidates.length === 0) return null;

  // Extract brain intent context
  const normalizedGoal =
    result.brainPlanning?.normalized_goal || "";
  const intentType = extractIntentType(result);
  const constraints = extractConstraints(result);

  const resolverResult = await resolveSources({
    rankedCandidates,
    normalizedGoal,
    intentType,
    constraints,
  });

  return resolverResult.ok ? resolverResult.sourceContext : null;
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
