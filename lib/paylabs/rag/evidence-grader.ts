/**
 * Internal Evidence Relevance Grader
 *
 * Grades retrieved evidence chunks after hybrid ranking.
 * This is NOT a new PayLab agent or service.
 * This creates NO x402/payment edge.
 *
 * Flow: ranked chunks → deterministic prefilter → bounded LLM grade/fallback → truthful GradedEvidenceChunk[]
 *
 * The grader may REJECT or REDUCE support but NEVER INVENT support.
 * Entity/aspect coverage remains deterministic and authoritative.
 *
 * Invariants enforced:
 *  - Every returned chunk has gradingMode ∈ {deterministic_reject, llm, deterministic_fallback}
 *  - gradingMode="llm" ONLY if an actual valid LLM grade was received for that chunk
 *  - Post-intersection: LLM cannot claim relevant=true when required support is empty
 *  - Bounded grading deadline; exceeded candidates become deterministic_fallback
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
import type { RouteTier } from "@/lib/paylabs/route-tier";

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

// ─── Deterministic Fallback for Non-Selected Chunks ────────

/**
 * Conservative deterministic fallback for chunks not selected for LLM grading
 * or whose LLM grade was missing/failed. Uses deterministic support authority —
 * relevant=true ONLY if deterministic rules allow it.
 */
function deterministicFallback(
  ranked: RankedEvidenceChunk,
  retrievalContext: RetrievalContext,
): EvidenceGrade {
  const { relevance } = ranked;
  const hasRequestedAspects = retrievalContext.requestedAspects.length > 0;
  const hasEntitySupport = relevance.entitySupport.length > 0;
  const hasAspectSupport = relevance.aspectSupport.length > 0;

  // If aspects are requested but this chunk has none → not relevant
  if (hasRequestedAspects && !hasAspectSupport) {
    return {
      relevant: false,
      entitySupport: relevance.entitySupport,
      aspectSupport: [],
      supportStrength: Math.min(relevance.score, 0.5),
      rejectionReason: "entity_only_no_requested_aspect",
      gradingMode: "deterministic_fallback",
    };
  }

  // No entity or aspect support at all → weak
  if (!hasEntitySupport && !hasAspectSupport) {
    return {
      relevant: false,
      entitySupport: [],
      aspectSupport: [],
      supportStrength: Math.min(relevance.score, 0.5),
      rejectionReason: "does_not_answer_query",
      gradingMode: "deterministic_fallback",
    };
  }

  return {
    relevant: true,
    entitySupport: relevance.entitySupport,
    aspectSupport: relevance.aspectSupport,
    supportStrength: Math.min(relevance.score, 0.5),
    rejectionReason: null,
    gradingMode: "deterministic_fallback",
  };
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
 * Only includes grades for chunk IDs that were in the submitted batch
 * (unknown/duplicate chunk IDs from LLM response are ignored).
 */
async function gradeBatch(
  retrievalContext: RetrievalContext,
  batch: RankedEvidenceChunk[],
  agentName: string,
  routeTier: RouteTier,
): Promise<Map<string, LlmChunkGrade>> {
  const result = await generateStructuredJson({
    agentName,
    routeTier,
    systemPrompt: GRADING_SYSTEM_PROMPT,
    userPrompt: buildBatchPrompt(retrievalContext, batch),
    schema: BatchGradingSchema,
    maxAttempts: 1,
    allowRepair: false,
  });

  if (!result.ok || !result.data) {
    return new Map();
  }

  // Validate: only include grades for chunk IDs that were in the submitted batch
  const batchIds = new Set(batch.map((item) => item.chunk.id));
  const data = result.data as z.infer<typeof BatchGradingSchema>;
  const grades = new Map<string, LlmChunkGrade>();

  for (const grade of data.grades) {
    if (batchIds.has(grade.chunk_id)) {
      grades.set(grade.chunk_id, grade);
    }
    // Unknown chunk IDs silently ignored — never grade a chunk not in the batch
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

// ─── Post-Intersection Consistency ─────────────────────────

/**
 * Enforce post-intersection consistency.
 * After intersection, if the LLM claims relevant=true but required trusted support is empty,
 * override to relevant=false. The LLM may REMOVE support — once removed, relevance must
 * reflect that removal.
 */
function enforcePostIntersectionConsistency(
  grade: EvidenceGrade,
  retrievalContext: RetrievalContext,
): EvidenceGrade {
  if (!grade.relevant) return grade;

  const hasRequiredEntities = retrievalContext.primaryEntities.some((e) => e.required);
  const hasRequestedAspects = retrievalContext.requestedAspects.length > 0;

  // If required primary entities exist but final trusted entitySupport is empty
  if (hasRequiredEntities && grade.entitySupport.length === 0) {
    return {
      ...grade,
      relevant: false,
      supportStrength: Math.min(grade.supportStrength, 0.3),
      rejectionReason: "does_not_answer_query",
    };
  }

  // If requestedAspects exist and final trusted aspectSupport is empty
  if (hasRequestedAspects && grade.aspectSupport.length === 0) {
    return {
      ...grade,
      relevant: false,
      supportStrength: Math.min(grade.supportStrength, 0.3),
      rejectionReason: grade.entitySupport.length > 0
        ? "entity_only_no_requested_aspect"
        : "does_not_answer_query",
    };
  }

  return grade;
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
 * Grade evidence chunks using deterministic prefilter + bounded LLM grading.
 *
 * Every input chunk receives a truthful grade:
 *  1. deterministic_reject — deterministic prefilter rules
 *  2. llm — actual valid LLM grade received and applied
 *  3. deterministic_fallback — not selected for LLM, LLM unavailable,
 *     batch failed, grade missing, or deadline reached
 */
export async function gradeEvidenceChunks(params: {
  retrievalContext: RetrievalContext;
  rankedChunks: RankedEvidenceChunk[];
  routeTier?: RouteTier;
}): Promise<EvidenceGradingResult> {
  const { retrievalContext, rankedChunks, routeTier } = params;
  const agentName = "source_verifier";

  let llmCalls = 0;
  let gradedCount = 0;
  let deterministicRejectCount = 0;

  const results: GradedEvidenceChunk[] = [];
  const candidateIndices: number[] = [];
  const llmGradedIds = new Set<string>();

  // ── Phase 1: Deterministic prefilter ──────────────────────
  for (const ranked of rankedChunks) {
    const detGrade = deterministicReject(ranked, retrievalContext);
    if (detGrade) {
      results.push({
        chunk: ranked.chunk,
        relevance: ranked.relevance,
        grade: detGrade,
      });
      deterministicRejectCount++;
    } else {
      // Not rejected — mark as candidate. Will be finalized in Phase 2/3.
      results.push({
        chunk: ranked.chunk,
        relevance: ranked.relevance,
        grade: {
          relevant: false,
          entitySupport: ranked.relevance.entitySupport,
          aspectSupport: ranked.relevance.aspectSupport,
          supportStrength: ranked.relevance.score,
          rejectionReason: null,
          gradingMode: "deterministic_fallback", // default until LLM grades or fallback applied
        },
      });
      candidateIndices.push(results.length - 1);
    }
  }

  // ── Phase 2: Bounded LLM grading ─────────────────────────
  let llmAvailable = false;

  if (candidateIndices.length > 0) {
    const deadline = Date.now() + GRADING_CONFIG.gradingTimeoutMs;

    // Select with source diversity (max 12)
    const selectedCandidates = selectLlmCandidates(
      candidateIndices.map((i) => ({
        chunk: results[i].chunk,
        relevance: results[i].relevance,
      })),
      GRADING_CONFIG.maxLlmCandidates,
    );
    const selectedIds = new Set(selectedCandidates.map((c) => c.chunk.id));

    // Finalize non-selected plausible chunks with deterministic fallback
    for (const idx of candidateIndices) {
      if (!selectedIds.has(results[idx].chunk.id)) {
        results[idx].grade = deterministicFallback(
          { chunk: results[idx].chunk, relevance: results[idx].relevance },
          retrievalContext,
        );
      }
    }

    // Batch LLM grading for selected candidates only
    const batchable = candidateIndices.filter((idx) =>
      selectedIds.has(results[idx].chunk.id),
    );

    for (let b = 0; b < batchable.length; b += GRADING_CONFIG.batchSize) {
      // Budget guard
      if (llmCalls >= GRADING_CONFIG.maxLlmCalls) break;
      // Deadline guard — stop starting new batches
      if (Date.now() >= deadline) break;

      const batch = batchable.slice(b, b + GRADING_CONFIG.batchSize);
      const batchItems = batch.map((i) => ({
        chunk: results[i].chunk,
        relevance: results[i].relevance,
      }));

      try {
        const batchGrades = await gradeBatch(
          retrievalContext,
          batchItems,
          agentName,
          routeTier ?? ("normal" as RouteTier),
        );
        llmCalls++;

        if (batchGrades.size > 0) {
          llmAvailable = true;
        }

        for (const idx of batch) {
          const llmGrade = batchGrades.get(results[idx].chunk.id);
          if (llmGrade) {
            // Intersect support: LLM can reduce, never invent
            const { entitySupport, aspectSupport } = intersectSupport(
              llmGrade.entity_support,
              llmGrade.aspect_support,
              results[idx].relevance.entitySupport,
              results[idx].relevance.aspectSupport,
            );

            let grade: EvidenceGrade = {
              relevant: llmGrade.relevant,
              entitySupport,
              aspectSupport,
              supportStrength: Math.max(0, Math.min(1, llmGrade.support_strength)),
              rejectionReason: llmGrade.rejection_reason,
              gradingMode: "llm",
            };

            // Post-intersection consistency: LLM may not claim relevant=true
            // when required support was removed by intersection
            grade = enforcePostIntersectionConsistency(
              grade,
              retrievalContext,
            );

            results[idx].grade = grade;
            llmGradedIds.add(results[idx].chunk.id);
            gradedCount++;
          }
          // If LLM didn't return a grade for this chunk, it stays at
          // deterministic_fallback default — finalized in Phase 3
        }
      } catch {
        // LLM batch failed — all in batch stay at deterministic_fallback default
      }
    }
  }

  // ── Phase 3: Finalize any candidate not LLM-graded ────────
  // Covers: non-selected, deadline-exceeded, max-calls-exceeded,
  //         LLM-failed, grade-missing. No chunk remains with a
  //         provisional/stale grade.
  for (const idx of candidateIndices) {
    if (!llmGradedIds.has(results[idx].chunk.id)) {
      results[idx].grade = deterministicFallback(
        { chunk: results[idx].chunk, relevance: results[idx].relevance },
        retrievalContext,
      );
    }
  }

  // ── Phase 4: Sort — relevant first, then supportStrength, then hybrid score ──
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
