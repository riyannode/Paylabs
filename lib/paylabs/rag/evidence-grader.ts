/**
 * Internal Evidence Relevance Grader
 *
 * Grades retrieved evidence chunks after hybrid ranking.
 * This is NOT a new PayLab agent or service.
 * This creates NO x402/payment edge.
 *
 * Flow: ranked chunks → deterministic prefilter → LLM grader → graded chunks
 *
 * The grader may REJECT or REDUCE support but NEVER INVENT support.
 * Entity/aspect coverage remains deterministic and authoritative.
 */

import { z } from "zod";
import type { RetrievalContext } from "../sources/types";
import type {
  EvidenceChunk,
  ChunkRelevance,
  RankedEvidenceChunk,
  EvidenceGrade,
  GradedEvidenceChunk,
  EvidenceGradingResult,
} from "./types";
import { generateStructuredJson } from "../ai/llm-structured";

// ─── Configuration ─────────────────────────────────────────

const GRADING_CONFIG = {
  /** Minimum hybrid relevance score to consider for LLM grading */
  minScoreForLlm: 0.20,
  /** Maximum chunks to send to LLM grader */
  maxLlmCandidates: 12,
  /** Chunks per LLM batch */
  batchSize: 4,
  /** Maximum LLM calls */
  maxLlmCalls: 3,
  /** Maximum text length per chunk sent to LLM */
  maxChunkTextLength: 1500,
  /** Overall grading timeout in ms */
  gradingTimeoutMs: 20_000,
} as const;

// ─── Deterministic Rejection Rules ─────────────────────────

/**
 * Apply deterministic rejection rules before any LLM call.
 * Returns a grade if the chunk should be deterministically rejected,
 * or null if it should proceed to LLM grading.
 */
function deterministicReject(
  ranked: RankedEvidenceChunk,
  retrievalContext: RetrievalContext,
): EvidenceGrade | null {
  const { relevance, chunk } = ranked;
  const hasRequiredEntities = retrievalContext.primaryEntities.some((e) => e.required);
  const hasRequestedAspects = retrievalContext.requestedAspects.length > 0;

  // Already rejected by hybrid ranker
  if (relevance.rejectionReason === "missing_required_entity") {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: [],
      supportStrength: 0,
      rejectionReason: "does_not_answer_query",
      gradingMode: "deterministic_reject",
    };
  }

  // metadata_only for technical queries — too weak
  if (chunk.metadata.evidenceGranularity === "metadata_only") {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: [],
      supportStrength: 0.05,
      rejectionReason: "metadata_only",
      gradingMode: "deterministic_reject",
    };
  }

  // Very short / empty chunk
  if (chunk.text.length < 50) {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: relevance.aspectSupport,
      supportStrength: 0.05,
      rejectionReason: "insufficient_content",
      gradingMode: "deterministic_reject",
    };
  }

  // Entity-only with no aspect when aspects are requested
  if (
    hasRequiredEntities &&
    relevance.entitySupport.length > 0 &&
    relevance.aspectSupport.length === 0 &&
    hasRequestedAspects
  ) {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: [],
      supportStrength: Math.min(relevance.score, 0.15),
      rejectionReason: "entity_only_no_requested_aspect",
      gradingMode: "deterministic_reject",
    };
  }

  // Very low hybrid score — unlikely to be useful
  if (relevance.score < GRADING_CONFIG.minScoreForLlm) {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: relevance.aspectSupport,
      supportStrength: relevance.score,
      rejectionReason: "weak_or_indirect_support",
      gradingMode: "deterministic_reject",
    };
  }

  return null; // proceed to LLM grading
}

// ─── LLM Grader ────────────────────────────────────────────

const GRADING_SYSTEM_PROMPT = `You are an evidence relevance grader for PayLabs.
Your ONLY job: evaluate whether each supplied evidence chunk substantively helps answer the user's question.
Do NOT answer the question. Do NOT use outside knowledge. Do NOT add information not present in the evidence.
Evaluate ONLY the supplied text. Absence of evidence is not evidence.
Entity mention alone is insufficient for a technical requested aspect — the chunk must discuss the aspect substantively.
Return JSON only. No reasoning. No chain-of-thought.`;

const ChunkGradeSchema = z.object({
  chunk_id: z.string(),
  relevant: z.boolean(),
  entity_support: z.array(z.string()),
  aspect_support: z.array(z.string()),
  support_strength: z.number().min(0).max(1),
  rejection_reason: z.enum([
    "does_not_answer_query",
    "entity_only_no_requested_aspect",
    "weak_or_indirect_support",
    "metadata_only",
    "duplicate_or_redundant",
    "insufficient_content",
  ]).nullable(),
}).strict();

const BatchGradingSchema = z.object({
  grades: z.array(ChunkGradeSchema),
}).strict();

type LlmChunkGrade = z.infer<typeof ChunkGradeSchema>;

/**
 * Build the user prompt for a batch of chunks.
 */
function buildBatchPrompt(
  retrievalContext: RetrievalContext,
  batch: RankedEvidenceChunk[],
): string {
  const parts: string[] = [
    `User question: ${retrievalContext.originalGoal}`,
    `Intent: ${retrievalContext.intentType || "unknown"}`,
    `Required entities: ${retrievalContext.primaryEntities.filter((e) => e.required).map((e) => e.canonical).join(", ") || "none"}`,
    `Requested aspects: ${retrievalContext.requestedAspects.join(", ") || "none"}`,
    "",
  ];

  for (const item of batch) {
    const { chunk, relevance } = item;
    parts.push(`[${chunk.id}]`);
    parts.push(`Title: ${chunk.metadata.title}`);
    parts.push(`Domain: ${chunk.metadata.domain || "unknown"}`);
    parts.push(`Granularity: ${chunk.metadata.evidenceGranularity}`);
    parts.push(`Entity support (deterministic): ${relevance.entitySupport.join(", ") || "none"}`);
    parts.push(`Aspect support (deterministic): ${relevance.aspectSupport.join(", ") || "none"}`);
    parts.push(`Evidence text: ${chunk.text.slice(0, GRADING_CONFIG.maxChunkTextLength)}`);
    parts.push("");
  }

  parts.push(`For each chunk, return a JSON object with:
- chunk_id: the chunk identifier
- relevant: true if substantively helps answer, false otherwise
- entity_support: entity names from deterministic support that are genuinely supported (subset only, never add new ones)
- aspect_support: aspects from deterministic support that are genuinely covered (subset only, never add new ones)
- support_strength: 0..1 normalized strength of evidence support
- rejection_reason: specific reason if not relevant, null if relevant`);

  return parts.join("\n");
}

/**
 * Grade a batch of chunks via LLM.
 * Returns grades keyed by chunk_id.
 */
async function gradeBatch(
  retrievalContext: RetrievalContext,
  batch: RankedEvidenceChunk[],
  agentName: string,
): Promise<Map<string, LlmChunkGrade>> {
  const result = await generateStructuredJson({
    agentName,
    routeTier: "normal",
    systemPrompt: GRADING_SYSTEM_PROMPT,
    userPrompt: buildBatchPrompt(retrievalContext, batch),
    schema: BatchGradingSchema,
    maxAttempts: 1,
    allowRepair: false,
  });

  if (!result.ok || !result.data) {
    return new Map();
  }

  const data = result.data as z.infer<typeof BatchGradingSchema>;
  const grades = new Map<string, LlmChunkGrade>();
  for (const grade of data.grades) {
    grades.set(grade.chunk_id, grade);
  }
  return grades;
}

// ─── Support Intersection ──────────────────────────────────

/**
 * Intersect LLM-claimed support with deterministic support.
 * LLM may REDUCE support but NEVER INVENT new support.
 */
function intersectSupport(
  llmEntitySupport: string[],
  llmAspectSupport: string[],
  deterministicEntitySupport: string[],
  deterministicAspectSupport: string[],
): { entitySupport: string[]; aspectSupport: string[] } {
  const detEntitySet = new Set(deterministicEntitySupport.map((e) => e.toLowerCase()));
  const detAspectSet = new Set(deterministicAspectSupport);

  const entitySupport = llmEntitySupport.filter((e) => detEntitySet.has(e.toLowerCase()));
  const aspectSupport = llmAspectSupport.filter((a) => detAspectSet.has(a));

  return { entitySupport, aspectSupport };
}

// ─── Source Diversity Selection ─────────────────────────────

/**
 * Select LLM candidates preserving source diversity.
 * Don't spend all capacity on chunks from one source.
 */
function selectLlmCandidates(
  ranked: RankedEvidenceChunk[],
  maxCandidates: number,
): RankedEvidenceChunk[] {
  // Group by source
  const bySource = new Map<string, RankedEvidenceChunk[]>();
  for (const item of ranked) {
    const sourceId = item.chunk.sourceId;
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId)!.push(item);
  }

  // Round-robin across sources, highest score first within each source
  const selected: RankedEvidenceChunk[] = [];
  const sourceIterators = new Map<string, Iterator<RankedEvidenceChunk>>();

  for (const [sourceId, items] of bySource) {
    items.sort((a, b) => b.relevance.score - a.relevance.score);
    sourceIterators.set(sourceId, items[Symbol.iterator]());
  }

  while (selected.length < maxCandidates) {
    let addedAny = false;
    for (const [sourceId, iter] of sourceIterators) {
      if (selected.length >= maxCandidates) break;
      const next = iter.next();
      if (!next.done) {
        selected.push(next.value);
        addedAny = true;
      } else {
        sourceIterators.delete(sourceId);
      }
    }
    if (!addedAny) break;
  }

  return selected;
}

// ─── Main Grading Function ─────────────────────────────────

/**
 * Grade evidence chunks using deterministic prefilter + optional LLM grading.
 *
 * Every input chunk receives a grade. The grader may reject or reduce support
 * but never invent new entity/aspect coverage.
 */
export async function gradeEvidenceChunks(params: {
  retrievalContext: RetrievalContext;
  rankedChunks: RankedEvidenceChunk[];
  routeTier?: string;
}): Promise<EvidenceGradingResult> {
  const { retrievalContext, rankedChunks } = params;
  const agentName = "source_verifier";

  let llmCalls = 0;
  let llmAvailable = true;
  let gradedCount = 0;
  let deterministicRejectCount = 0;

  const results: GradedEvidenceChunk[] = [];

  for (const ranked of rankedChunks) {
    // Phase 1: Deterministic prefilter
    const detGrade = deterministicReject(ranked, retrievalContext);
    if (detGrade) {
      results.push({
        chunk: ranked.chunk,
        relevance: ranked.relevance,
        grade: detGrade,
      });
      deterministicRejectCount++;
      continue;
    }
    // Mark as candidate for LLM grading — will be batched below
    results.push({
      chunk: ranked.chunk,
      relevance: ranked.relevance,
      grade: {
        relevant: true, // provisional — will be overridden by LLM
        entitySupport: ranked.relevance.entitySupport,
        aspectSupport: ranked.relevance.aspectSupport,
        supportStrength: ranked.relevance.score,
        rejectionReason: null,
        gradingMode: "llm",
      },
    });
  }

  // Phase 2: LLM grading for non-rejected candidates
  const candidates = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.grade.gradingMode === "llm");

  if (candidates.length > 0) {
    // Select with source diversity
    const selectedCandidates = selectLlmCandidates(
      candidates.map(({ r }) => ({
        chunk: r.chunk,
        relevance: r.relevance,
      })),
      GRADING_CONFIG.maxLlmCandidates,
    );

    // Batch and grade
    const selectedIds = new Set(selectedCandidates.map((c) => c.chunk.id));
    const batchable = candidates.filter(({ r }) => selectedIds.has(r.chunk.id));

    for (let b = 0; b < batchable.length; b += GRADING_CONFIG.batchSize) {
      if (llmCalls >= GRADING_CONFIG.maxLlmCalls) break;

      const batch = batchable.slice(b, b + GRADING_CONFIG.batchSize);
      const batchItems = batch.map(({ r }) => ({
        chunk: r.chunk,
        relevance: r.relevance,
      }));

      try {
        const batchGrades = await gradeBatch(retrievalContext, batchItems, agentName);
        llmCalls++;

        for (const { r, i } of batch) {
          const llmGrade = batchGrades.get(r.chunk.id);
          if (llmGrade) {
            // Intersect support: LLM can reduce, never invent
            const { entitySupport, aspectSupport } = intersectSupport(
              llmGrade.entity_support,
              llmGrade.aspect_support,
              r.relevance.entitySupport,
              r.relevance.aspectSupport,
            );

            results[i].grade = {
              relevant: llmGrade.relevant,
              entitySupport,
              aspectSupport,
              supportStrength: Math.max(0, Math.min(1, llmGrade.support_strength)),
              rejectionReason: llmGrade.rejection_reason,
              gradingMode: "llm",
            };
            gradedCount++;
          } else {
            // LLM didn't return grade for this chunk — fallback
            results[i].grade = {
              relevant: true,
              entitySupport: r.relevance.entitySupport,
              aspectSupport: r.relevance.aspectSupport,
              supportStrength: Math.min(r.relevance.score, 0.5),
              rejectionReason: null,
              gradingMode: "deterministic_fallback",
            };
          }
        }
      } catch {
        // LLM batch failed — mark all in batch as fallback
        llmAvailable = false;
        for (const { r, i } of batch) {
          results[i].grade = {
            relevant: true,
            entitySupport: r.relevance.entitySupport,
            aspectSupport: r.relevance.aspectSupport,
            supportStrength: Math.min(r.relevance.score, 0.5),
            rejectionReason: null,
            gradingMode: "deterministic_fallback",
          };
        }
      }
    }
  }

  // Phase 3: Sort — relevant first, then supportStrength, then hybrid score
  results.sort((a, b) => {
    if (a.grade.relevant !== b.grade.relevant) return a.grade.relevant ? -1 : 1;
    if (a.grade.supportStrength !== b.grade.supportStrength) return b.grade.supportStrength - a.grade.supportStrength;
    return b.relevance.score - a.relevance.score;
  });

  return {
    chunks: results,
    llmCalls,
    llmAvailable,
    gradedCount,
    deterministicRejectCount,
  };
}
