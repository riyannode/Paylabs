/**
 * Source-Grounded Final Answer Builder
 *
 * Generates a concise source availability note for the Source Summary section.
 * The actual ANSWER is Brain LLM's assistant_response (natural LLM answer).
 * Source details are rendered as Link pills from source_context.sources_used.
 *
 * Rules:
 * - Do NOT output numbered source list [1]/[2]/[3] — that belongs in Link pills only.
 * - Return only a concise availability note.
 * - No raw CoT. No raw RSS payload. No fabricated facts.
 */

import type { SourceItem } from "./types";

// ─── Types ──────────────────────────────────────────────────

export interface FinalAnswerInput {
  goal: string;
  sourcesUsed: SourceItem[];
  sourceConfidence: number;
  retrievalMode?: string;
  maxSourcesInAnswer?: number;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Build a concise source availability note.
 * The Brain LLM assistant_response is the real ANSWER.
 * This function returns a note for the Source Summary section only.
 */
export function buildSourceGroundedFinalAnswer(
  input: FinalAnswerInput
): string {
  const { sourcesUsed, sourceConfidence } = input;

  if (!sourcesUsed || sourcesUsed.length === 0) {
    return "No sufficiently relevant live sources were found for this query. The route completed with basic discovery, but PayLabs did not attach source links because no source passed the relevance gate.";
  }

  const count = sourcesUsed.length;
  const domains = [...new Set(sourcesUsed.map((s) => s.domain).filter(Boolean))];
  const domainList = domains.slice(0, 3).join(", ");

  if (sourceConfidence < 0.3) {
    return `Found ${count} source${count > 1 ? "s" : ""}${domainList ? ` from ${domainList}` : ""}. Source relevance is limited — results may be less accurate.`;
  }

  return `Found ${count} relevant source${count > 1 ? "s" : ""}${domainList ? ` from ${domainList}` : ""}. See links below for details.`;
}
