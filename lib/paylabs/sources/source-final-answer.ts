/**
 * Source-Grounded Final Answer Builder
 *
 * Generates a concise user-facing answer from source_context.
 * Deterministic — no LLM for v1.
 *
 * Rules:
 * - Use only safe source fields: title, summary, domain, published_at, provider.
 * - If sources exist: answer what was found, mention links below.
 * - If no source: explicit "no relevant source found" message.
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
 * Build a deterministic source-grounded final answer.
 * v1: template-based summary. v2 (PR C/D): LLM from excerpts.
 */
export function buildSourceGroundedFinalAnswer(
  input: FinalAnswerInput
): string {
  const {
    goal,
    sourcesUsed,
    sourceConfidence,
    retrievalMode,
    maxSourcesInAnswer = 5,
  } = input;

  // No sources found
  if (!sourcesUsed || sourcesUsed.length === 0) {
    return "Tidak menemukan source yang cukup relevan untuk menjawab pertanyaan ini. Coba dengan query yang lebih spesifik atau topik berbeda.";
  }

  // Sources found — build answer
  const topSources = sourcesUsed.slice(0, maxSourcesInAnswer);
  const totalSources = sourcesUsed.length;

  // Group by provider
  const providers = new Set(
    topSources.map((s) => {
      if (s.source_kind === "rsshub_live") return "RSSHub";
      if (s.source_kind === "tavily_live") return "Web Search";
      return "Database";
    })
  );

  // Build domains list
  const domains = new Set(
    topSources.map((s) => s.domain).filter(Boolean)
  );

  // Build answer
  const parts: string[] = [];

  // Opening
  parts.push(
    `Ditemukan ${totalSources} source relevan dari ${providers.size > 1 ? "beberapa provider" : [...providers][0] || "RSSHub"}.`
  );

  // Key findings from source titles
  const uniqueDomains = [...domains].slice(0, 3);
  if (uniqueDomains.length > 0) {
    parts.push(
      `Sumber dari: ${uniqueDomains.join(", ")}.`
    );
  }

  // Source-backed bullets (title-based only for v1)
  if (topSources.length > 0) {
    parts.push("Sumber utama:");
    for (let i = 0; i < Math.min(topSources.length, 3); i++) {
      const s = topSources[i];
      const domain = s.domain ? ` (${s.domain})` : "";
      parts.push(`[${i + 1}] ${s.title}${domain}`);
    }
  }

  // Confidence note if low
  if (sourceConfidence < 0.3) {
    parts.push(
      "Catatan: relevansi sumber masih terbatas. Hasil bisa kurang akurat."
    );
  }

  // Retrieval mode note
  if (retrievalMode && retrievalMode !== "rsshub_live") {
    parts.push(`(Mode: ${retrievalMode})`);
  }

  return parts.join(" ");
}
