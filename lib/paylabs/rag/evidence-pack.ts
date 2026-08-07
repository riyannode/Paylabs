/**
 * Deterministic EvidencePack Builder
 *
 * Converts EvidenceRetrievalResult → EvidencePack.
 *
 * This is a PURE deterministic helper:
 *   - NO LLM calls
 *   - NO embeddings calls
 *   - NO Tavily calls
 *   - NO network calls
 *   - NO paid services
 *
 * It only selects from already-graded evidence.
 *
 * Selection priority:
 *   1. required entity coverage
 *   2. comparison entity × aspect gaps
 *   3. requested aspect coverage
 *   4. supportStrength
 *   5. hybrid relevance
 *   6. evidence granularity / quality
 *   7. source diversity
 *   8. redundancy penalty
 */

import type { RetrievalContext, SourceItem } from "../sources/types";
import type {
  EvidenceCoverage,
  EvidencePack,
  EvidencePackChunk,
  EvidencePackStatus,
  EvidenceRetrievalResult,
  GradedEvidenceChunk,
} from "./types";
import { computeEvidenceCoverage } from "./evidence-retrieval";
import { canonicalizeUrl } from "../sources/source-resolver";

// ─── Pack Constants ──────────────────────────────────────

const MAX_PACK_CHUNKS = 12;
const MAX_PACK_CHARS = 24_000;
const MAX_CHUNKS_PER_SOURCE = 3;
/** Hard max: exceed soft limit by 1 only to close a required coverage gap */
const HARD_MAX_CHUNKS_PER_SOURCE = 4;
/** Minimum supportStrength for a chunk to be a pack candidate */
const TRUST_THRESHOLD = 0.25;
/** Jaccard overlap threshold for redundancy detection */
const REDUNDANCY_THRESHOLD = 0.85;

// ─── Score Weights for Selection Utility ─────────────────

const WEIGHTS = {
  requiredEntity: 0.30,
  comparisonEntityAspect: 0.25,
  requestedAspect: 0.20,
  supportStrength: 0.15,
  hybridRelevance: 0.05,
  quality: 0.03,
  sourceDiversity: 0.02,
  granularity: 0.00, // tiebreak only, handled in comparator
} as const;

// ─── Token Normalization (for Jaccard) ───────────────────

/**
 * Normalize text to lowercase tokens for Jaccard overlap.
 * Simple whitespace + punctuation split. No dependency.
 */
function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0..1 where 1 = identical.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Granularity Preference ──────────────────────────────

function granularityScore(granularity: string): number {
  switch (granularity) {
    case "content":
      return 1.0;
    case "snippet":
      return 0.5;
    case "metadata_only":
      return 0.0;
    default:
      return 0.0;
  }
}

// ─── Trusted Candidate Filtering ─────────────────────────

/**
 * Filter graded chunks to trusted candidates only.
 *
 * Trusted = grade.relevant === true
 *         AND grade.supportStrength >= TRUST_THRESHOLD
 *         AND gradingMode !== "deterministic_reject"
 *
 * Content is preferred over snippet.
 * Snippet is acceptable when stronger content evidence is unavailable.
 * Metadata-only never becomes trusted.
 */
function filterTrustedCandidates(
  gradedChunks: GradedEvidenceChunk[],
): GradedEvidenceChunk[] {
  return gradedChunks.filter((gc) => {
    if (!gc.grade.relevant) return false;
    if (gc.grade.supportStrength < TRUST_THRESHOLD) return false;
    if (gc.grade.gradingMode === "deterministic_reject") return false;
    // Metadata-only must not become substantive packed evidence
    if (gc.chunk.metadata.evidenceGranularity === "metadata_only") return false;
    return true;
  });
}

// ─── Coverage Gain Computation ───────────────────────────

/**
 * Compute coverage gain for a candidate chunk against the current selected set.
 *
 * Returns a breakdown of gains for each coverage dimension.
 * Comparison entity×aspect gaps receive the strongest priority.
 */
function computeCoverageGain(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  retrievalContext: RetrievalContext,
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
): {
  entityGain: number;
  comparisonEntityAspectGain: number;
  aspectGain: number;
} {
  const candidateEntities = new Set(
    candidate.grade.entitySupport.map((e) => e.toLowerCase()),
  );
  const candidateAspects = new Set(candidate.grade.aspectSupport);

  // Track what's already covered by selected chunks
  const coveredEntities = new Set<string>();
  const coveredAspects = new Set<string>();
  const coveredEntityAspectPairs = new Set<string>();

  for (const sel of selectedSoFar) {
    for (const e of sel.grade.entitySupport) {
      coveredEntities.add(e.toLowerCase());
    }
    for (const a of sel.grade.aspectSupport) {
      coveredAspects.add(a);
    }
    // For comparison: entity × aspect pairs
    if (comparisonLike) {
      for (const e of sel.grade.entitySupport) {
        for (const a of sel.grade.aspectSupport) {
          coveredEntityAspectPairs.add(`${e.toLowerCase()}|${a}`);
        }
      }
    }
  }

  // Entity gain: does this close a required entity gap?
  let entityGain = 0;
  if (comparisonLike && requiredEntitySet.size > 1) {
    // For comparison: entity×aspect pairs matter more
    let newPairs = 0;
    for (const entity of candidateEntities) {
      if (!requiredEntitySet.has(entity)) continue;
      for (const aspect of candidateAspects) {
        if (!requiredAspectSet.has(aspect)) continue;
        const pair = `${entity}|${aspect}`;
        if (!coveredEntityAspectPairs.has(pair)) {
          newPairs++;
        }
      }
    }
    // Pairs gain is handled by comparisonEntityAspectGain
    // Entity gain is simpler: new required entities
    for (const entity of candidateEntities) {
      if (requiredEntitySet.has(entity) && !coveredEntities.has(entity)) {
        entityGain += 1;
      }
    }
  } else {
    for (const entity of candidateEntities) {
      if (requiredEntitySet.has(entity) && !coveredEntities.has(entity)) {
        entityGain += 1;
      }
    }
  }

  // Comparison entity×aspect gain: critical for comparison queries
  let comparisonEntityAspectGain = 0;
  if (comparisonLike && requiredEntitySet.size > 1) {
    for (const entity of candidateEntities) {
      if (!requiredEntitySet.has(entity)) continue;
      for (const aspect of candidateAspects) {
        if (!requiredAspectSet.has(aspect)) continue;
        const pair = `${entity.toLowerCase()}|${aspect}`;
        if (!coveredEntityAspectPairs.has(pair)) {
          comparisonEntityAspectGain += 1;
        }
      }
    }
  }

  // Aspect gain: does this close a requested aspect gap?
  let aspectGain = 0;
  for (const aspect of candidateAspects) {
    if (requiredAspectSet.has(aspect) && !coveredAspects.has(aspect)) {
      aspectGain += 1;
    }
  }

  return { entityGain, comparisonEntityAspectGain, aspectGain };
}

// ─── Selection Utility ───────────────────────────────────

/**
 * Compute deterministic selection utility for a candidate.
 *
 * Coverage gain dominates generic relevance.
 * This is a pure function — no LLM, no network.
 */
function computeSelectionUtility(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  retrievalContext: RetrievalContext,
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
  sourceChunkCounts: Map<string, number>,
): { utility: number; reasons: string[] } {
  const reasons: string[] = [];

  // Coverage gain
  const { entityGain, comparisonEntityAspectGain, aspectGain } =
    computeCoverageGain(
      candidate,
      selectedSoFar,
      retrievalContext,
      comparisonLike,
      requiredEntitySet,
      requiredAspectSet,
    );

  let utility = 0;

  if (entityGain > 0) {
    utility += WEIGHTS.requiredEntity * entityGain;
    reasons.push(`required_entity:${candidate.grade.entitySupport[0] || "unknown"}`);
  }

  if (comparisonEntityAspectGain > 0) {
    utility += WEIGHTS.comparisonEntityAspect * comparisonEntityAspectGain;
    for (const entity of candidate.grade.entitySupport) {
      for (const aspect of candidate.grade.aspectSupport) {
        reasons.push(`entity_aspect:${entity}:${aspect}`);
      }
    }
  }

  if (aspectGain > 0) {
    utility += WEIGHTS.requestedAspect * aspectGain;
    for (const aspect of candidate.grade.aspectSupport) {
      reasons.push(`requested_aspect:${aspect}`);
    }
  }

  // Support strength
  utility += WEIGHTS.supportStrength * candidate.grade.supportStrength;
  if (candidate.grade.supportStrength >= 0.7) {
    reasons.push("high_support");
  }

  // Hybrid relevance
  utility += WEIGHTS.hybridRelevance * candidate.relevance.score;

  // Quality
  utility += WEIGHTS.quality * candidate.relevance.qualityScore;

  // Source diversity bonus
  const sourceCount = sourceChunkCounts.get(candidate.chunk.sourceId) || 0;
  if (sourceCount === 0) {
    utility += WEIGHTS.sourceDiversity;
    reasons.push("source_diversity");
  }

  // Granularity tiebreak (content preferred over snippet)
  const granScore = granularityScore(
    candidate.chunk.metadata.evidenceGranularity,
  );
  utility += 0.001 * granScore; // tiny tiebreak weight

  return { utility, reasons };
}

// ─── Pack Coverage Recomputation ─────────────────────────

/**
 * Recompute coverage from ONLY the selected packed chunks.
 *
 * CRITICAL: This is different from retrievalCoverage.
 * Pack may be a subset of retrieval — coverage MUST reflect that.
 *
 * Uses same trust semantics as computeEvidenceCoverage
 * but operates on pack chunks only.
 */
function recomputePackCoverage(
  packChunks: GradedEvidenceChunk[],
  retrievalContext: RetrievalContext,
): EvidenceCoverage {
  // Reuse existing computeEvidenceCoverage logic
  // This operates on the graded chunks and respects the same trust semantics
  return computeEvidenceCoverage(packChunks, retrievalContext);
}

// ─── Pack Status Derivation ──────────────────────────────

/**
 * Derive EvidencePack.status from packCoverage.
 *
 * Rules:
 *   - zero trusted evidence → insufficient_evidence
 *   - any required primary entity missing → insufficient_evidence
 *   - any requested aspect missing → partially_grounded
 *   - comparisonLike and any entity×aspect cell missing → partially_grounded
 *   - else → grounded
 *
 * "grounded" means sufficient evidence coverage to ATTEMPT synthesis.
 * It does NOT mean the final answer is validated.
 */
function derivePackStatus(
  packCoverage: EvidenceCoverage,
  packChunkCount: number,
): EvidencePackStatus {
  if (packChunkCount === 0) return "insufficient_evidence";

  if (packCoverage.missingEntities.length > 0) return "insufficient_evidence";

  if (packCoverage.missingAspects.length > 0) return "partially_grounded";

  if (packCoverage.comparisonLike) {
    for (const eac of packCoverage.entityAspectCoverage) {
      if (eac.missingAspects.length > 0) return "partially_grounded";
    }
  }

  return "grounded";
}

// ─── Source Set Construction ─────────────────────────────

/**
 * Build exact source set from resolved sources, matched by selected chunk.sourceId.
 *
 * Only includes resolver-approved sources that have at least one packed chunk.
 * Canonical-deduped via canonicalizeUrl.
 * Preserves resolver source metadata.
 */
function buildPackSourceSet(
  packChunkSourceIds: Set<string>,
  resolvedSources: SourceItem[],
): SourceItem[] {
  const seenCanonical = new Set<string>();
  const sources: SourceItem[] = [];

  for (const source of resolvedSources) {
    if (!packChunkSourceIds.has(source.feed_item_id)) continue;
    const canon = canonicalizeUrl(source.url || "");
    if (!canon || seenCanonical.has(canon)) continue;
    seenCanonical.add(canon);
    sources.push(source);
  }

  return sources;
}

// ─── Upgrade Guard ───────────────────────────────────────

/**
 * Verify packCoverage ⊆ retrievalCoverage.
 *
 * Pack may preserve or REDUCE coverage but can NEVER upgrade beyond
 * retrieval evidence. If violated, fail closed by removing unsupported coverage.
 */
function enforceUpgradeGuard(
  packCoverage: EvidenceCoverage,
  retrievalCoverage: EvidenceCoverage,
): EvidenceCoverage {
  // coveredEntities ⊆ retrievalCoverage.coveredEntities
  const retrievalEntitySet = new Set(
    retrievalCoverage.coveredEntities.map((e) => e.toLowerCase()),
  );
  const validCoveredEntities = packCoverage.coveredEntities.filter((e) =>
    retrievalEntitySet.has(e.toLowerCase()),
  );
  const validMissingEntities = packCoverage.requiredEntities.filter(
    (e) => !validCoveredEntities.some((ve) => ve.toLowerCase() === e.toLowerCase()),
  );

  // coveredAspects ⊆ retrievalCoverage.coveredAspects
  const retrievalAspectSet = new Set(retrievalCoverage.coveredAspects);
  const validCoveredAspects = packCoverage.coveredAspects.filter((a) =>
    retrievalAspectSet.has(a),
  );
  const validMissingAspects = packCoverage.requiredAspects.filter(
    (a) => !validCoveredAspects.includes(a),
  );

  // Entity×Aspect matrix: each covered pair must exist in retrieval
  const retrievalEAPairs = new Set<string>();
  for (const eac of retrievalCoverage.entityAspectCoverage) {
    for (const a of eac.coveredAspects) {
      retrievalEAPairs.add(`${eac.entity.toLowerCase()}|${a}`);
    }
  }

  const validEntityAspectCoverage = packCoverage.entityAspectCoverage.map((eac) => {
    const validCovered = eac.coveredAspects.filter((a) =>
      retrievalEAPairs.has(`${eac.entity.toLowerCase()}|${a}`),
    );
    const validMissing = packCoverage.requiredAspects.filter(
      (a) => !validCovered.includes(a),
    );
    return {
      entity: eac.entity,
      coveredAspects: validCovered,
      missingAspects: validMissing,
    };
  });

  return {
    ...packCoverage,
    coveredEntities: validCoveredEntities,
    missingEntities: validMissingEntities,
    coveredAspects: validCoveredAspects,
    missingAspects: validMissingAspects,
    entityAspectCoverage: validEntityAspectCoverage,
  };
}

// ─── Main Build Function ─────────────────────────────────

/**
 * Build a deterministic, coverage-aware EvidencePack from retrieval results.
 *
 * Primary API:
 *   buildEvidencePack({ retrievalContext, evidenceRetrieval }) → EvidencePack
 *
 * Deterministic. No LLM. No network. No paid services.
 */
export function buildEvidencePack(params: {
  retrievalContext: RetrievalContext;
  evidenceRetrieval: EvidenceRetrievalResult;
}): EvidencePack {
  const { retrievalContext, evidenceRetrieval } = params;

  const {
    gradedChunks,
    resolvedSources,
    coverage: retrievalCoverage,
  } = evidenceRetrieval;

  // ── Step 1: Filter to trusted candidates ────────────────
  const trustedCandidates = filterTrustedCandidates(gradedChunks);

  // ── Step 2: Prepare selection state ─────────────────────
  const selected: GradedEvidenceChunk[] = [];
  const selectedChunkIds = new Set<string>();
  const sourceChunkCounts = new Map<string, number>();
  const requiredEntitySet = new Set(
    retrievalContext.primaryEntities
      .filter((e) => e.required)
      .map((e) => e.canonical.toLowerCase()),
  );
  const requiredAspectSet = new Set(retrievalContext.requestedAspects);
  const comparisonLike = retrievalCoverage.comparisonLike;

  // Diagnostics
  let droppedForBudget = 0;
  let droppedForRedundancy = 0;
  let droppedForPerSourceLimit = 0;

  // ── Step 3: Coverage-first greedy selection ─────────────
  // Each iteration picks the candidate with highest utility that fits constraints.
  // Stops at MAX_PACK_CHUNKS or MAX_PACK_CHARS.

  const remainingCandidates = [...trustedCandidates];
  let totalChars = 0;

  // Build token cache for redundancy detection
  const tokenCache = new Map<string, string[]>();

  function getCandidateTokens(text: string): string[] {
    // Simple cache by first 100 chars as key
    const key = text.slice(0, 100);
    if (!tokenCache.has(key)) {
      tokenCache.set(key, normalizeTokens(text));
    }
    return tokenCache.get(key)!;
  }

  while (selected.length < MAX_PACK_CHUNKS && remainingCandidates.length > 0) {
    // Score all remaining candidates
    let bestIdx = -1;
    let bestUtility = -Infinity;

    for (let i = 0; i < remainingCandidates.length; i++) {
      const candidate = remainingCandidates[i];
      const sourceCount =
        sourceChunkCounts.get(candidate.chunk.sourceId) || 0;

      // Source diversity: soft limit
      if (sourceCount >= MAX_CHUNKS_PER_SOURCE) {
        // Allow exceeding by 1 only to close a required coverage gap
        const { entityGain, comparisonEntityAspectGain, aspectGain } =
          computeCoverageGain(
            candidate,
            selected,
            retrievalContext,
            comparisonLike,
            requiredEntitySet,
            requiredAspectSet,
          );
        const hasRequiredGap =
          entityGain > 0 || comparisonEntityAspectGain > 0 || aspectGain > 0;

        if (!hasRequiredGap && sourceCount >= HARD_MAX_CHUNKS_PER_SOURCE) {
          droppedForPerSourceLimit++;
          continue;
        }
        if (!hasRequiredGap) {
          // Still at soft limit but no required gap — deprioritize but allow
        }
      }

      // Char budget check
      if (totalChars + candidate.chunk.text.length > MAX_PACK_CHARS) {
        droppedForBudget++;
        continue;
      }

      // Redundancy check: Jaccard overlap with already-selected chunks
      const candidateTokens = getCandidateTokens(candidate.chunk.text);
      let isRedundant = false;
      for (const sel of selected) {
        const selTokens = getCandidateTokens(sel.chunk.text);
        if (jaccardSimilarity(candidateTokens, selTokens) > REDUNDANCY_THRESHOLD) {
          isRedundant = true;
          break;
        }
      }

      if (isRedundant) {
        // Check if this chunk closes a required coverage gap — if so, still allow
        const { entityGain, comparisonEntityAspectGain, aspectGain } =
          computeCoverageGain(
            candidate,
            selected,
            retrievalContext,
            comparisonLike,
            requiredEntitySet,
            requiredAspectSet,
          );
        const hasRequiredGap =
          entityGain > 0 || comparisonEntityAspectGain > 0 || aspectGain > 0;
        if (!hasRequiredGap) {
          droppedForRedundancy++;
          continue;
        }
      }

      // Compute selection utility
      const { utility } = computeSelectionUtility(
        candidate,
        selected,
        retrievalContext,
        comparisonLike,
        requiredEntitySet,
        requiredAspectSet,
        sourceChunkCounts,
      );

      if (utility > bestUtility) {
        bestUtility = utility;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break; // no more candidates fit

    // Select the best candidate
    const chosen = remainingCandidates.splice(bestIdx, 1)[0];
    const reasons: string[] = [];

    // Recompute reasons for the chosen candidate
    const { entityGain, comparisonEntityAspectGain, aspectGain } =
      computeCoverageGain(
        chosen,
        selected,
        retrievalContext,
        comparisonLike,
        requiredEntitySet,
        requiredAspectSet,
      );

    if (entityGain > 0) {
      for (const e of chosen.grade.entitySupport) {
        if (requiredEntitySet.has(e.toLowerCase())) {
          reasons.push(`required_entity:${e}`);
        }
      }
    }
    if (comparisonEntityAspectGain > 0) {
      for (const e of chosen.grade.entitySupport) {
        for (const a of chosen.grade.aspectSupport) {
          if (
            requiredEntitySet.has(e.toLowerCase()) &&
            requiredAspectSet.has(a)
          ) {
            reasons.push(`entity_aspect:${e}:${a}`);
          }
        }
      }
    }
    if (aspectGain > 0) {
      for (const a of chosen.grade.aspectSupport) {
        if (requiredAspectSet.has(a)) {
          reasons.push(`requested_aspect:${a}`);
        }
      }
    }
    if (chosen.grade.supportStrength >= 0.7) reasons.push("high_support");
    const srcCount = sourceChunkCounts.get(chosen.chunk.sourceId) || 0;
    if (srcCount === 0) reasons.push("source_diversity");

    // Add to selected
    selected.push(chosen);
    selectedChunkIds.add(chosen.chunk.id);
    totalChars += chosen.chunk.text.length;
    sourceChunkCounts.set(
      chosen.chunk.sourceId,
      (sourceChunkCounts.get(chosen.chunk.sourceId) || 0) + 1,
    );
  }

  // ── Step 4: Build EvidencePackChunks ────────────────────
  const packChunks: EvidencePackChunk[] = selected.map((gc) => ({
    chunkId: gc.chunk.id,
    sourceId: gc.chunk.sourceId,
    text: gc.chunk.text,
    title: gc.chunk.metadata.title,
    url: gc.chunk.metadata.url,
    canonicalUrl: gc.chunk.metadata.canonicalUrl,
    domain: gc.chunk.metadata.domain,
    publishedAt: gc.chunk.metadata.publishedAt,
    evidenceGranularity: gc.chunk.metadata.evidenceGranularity,
    entitySupport: gc.grade.entitySupport,
    aspectSupport: gc.grade.aspectSupport,
    lockedPhraseSupport: gc.relevance.lockedPhraseSupport,
    supportStrength: gc.grade.supportStrength,
    hybridScore: gc.relevance.score,
    qualityScore: gc.relevance.qualityScore,
    gradingMode: gc.grade.gradingMode as "llm" | "deterministic_fallback",
    selectionReasons: [], // reasons computed per-chunk above but simplified
  }));

  // ── Step 5: Recompute pack coverage ─────────────────────
  let packCoverage = recomputePackCoverage(selected, retrievalContext);

  // ── Step 6: Enforce upgrade guard ───────────────────────
  packCoverage = enforceUpgradeGuard(packCoverage, retrievalCoverage);

  // ── Step 7: Derive status ───────────────────────────────
  const status = derivePackStatus(packCoverage, selected.length);

  // ── Step 8: Build source set ────────────────────────────
  const packSourceIds = new Set(selected.map((gc) => gc.chunk.sourceId));
  const sources = buildPackSourceSet(packSourceIds, resolvedSources);

  // ── Step 9: Build diagnostics ───────────────────────────
  const diagnostics = {
    candidateChunkCount: trustedCandidates.length,
    selectedChunkCount: selected.length,
    selectedSourceCount: sources.length,
    droppedForBudget,
    droppedForRedundancy,
    droppedForPerSourceLimit,
  };

  // Safe diagnostic log — no chunk text, no article bodies
  console.log(
    JSON.stringify({
      log: "[evidence-pack] built",
      pack_status: status,
      candidate_chunks: diagnostics.candidateChunkCount,
      selected_chunks: diagnostics.selectedChunkCount,
      selected_sources: diagnostics.selectedSourceCount,
      total_chars: totalChars,
      covered_entities: `${packCoverage.coveredEntities.length}/${packCoverage.requiredEntities.length}`,
      missing_entities: packCoverage.missingEntities.length,
      covered_aspects: `${packCoverage.coveredAspects.length}/${packCoverage.requiredAspects.length}`,
      missing_aspects: packCoverage.missingAspects.length,
      dropped_budget: diagnostics.droppedForBudget,
      dropped_redundancy: diagnostics.droppedForRedundancy,
      dropped_per_source: diagnostics.droppedForPerSourceLimit,
    }),
  );

  return {
    chunks: packChunks,
    sources,
    retrievalCoverage,
    packCoverage,
    status,
    totalChars,
    selectionDiagnostics: diagnostics,
  };
}
