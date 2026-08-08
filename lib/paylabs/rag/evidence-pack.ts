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
const HARD_MAX_CHUNKS_PER_SOURCE = 4;
const TRUST_THRESHOLD = 0.25;
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
} as const;

// ─── Token Normalization (for Jaccard) ───────────────────

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function granularityScore(granularity: string): number {
  switch (granularity) {
    case "content":
      return 1.0;
    case "snippet":
      return 0.5;
    default:
      return 0.0;
  }
}

// ─── Trusted Candidate Filtering ─────────────────────────

function filterTrustedCandidates(
  gradedChunks: GradedEvidenceChunk[],
): GradedEvidenceChunk[] {
  return gradedChunks.filter((graded) => {
    if (!graded.grade.relevant) return false;
    if (graded.grade.supportStrength < TRUST_THRESHOLD) return false;
    if (graded.grade.gradingMode === "deterministic_reject") return false;
    if (graded.chunk.metadata.evidenceGranularity === "metadata_only") return false;
    return true;
  });
}

// ─── Coverage Gain Computation ───────────────────────────

function computeCoverageGain(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
): {
  entityGain: number;
  comparisonEntityAspectGain: number;
  aspectGain: number;
} {
  const candidateEntities = new Set(
    candidate.grade.entitySupport.map((entity) => entity.toLowerCase()),
  );
  const candidateAspects = new Set(candidate.grade.aspectSupport);
  const coveredEntities = new Set<string>();
  const coveredAspects = new Set<string>();
  const coveredEntityAspectPairs = new Set<string>();

  for (const selected of selectedSoFar) {
    for (const entity of selected.grade.entitySupport) {
      coveredEntities.add(entity.toLowerCase());
    }
    for (const aspect of selected.grade.aspectSupport) {
      coveredAspects.add(aspect);
    }
    if (comparisonLike && requiredEntitySet.size > 1) {
      for (const entity of selected.grade.entitySupport) {
        for (const aspect of selected.grade.aspectSupport) {
          coveredEntityAspectPairs.add(`${entity.toLowerCase()}|${aspect}`);
        }
      }
    }
  }

  let entityGain = 0;
  for (const entity of candidateEntities) {
    if (requiredEntitySet.has(entity) && !coveredEntities.has(entity)) {
      entityGain++;
    }
  }

  let comparisonEntityAspectGain = 0;
  if (comparisonLike && requiredEntitySet.size > 1) {
    for (const entity of candidateEntities) {
      if (!requiredEntitySet.has(entity)) continue;
      for (const aspect of candidateAspects) {
        if (!requiredAspectSet.has(aspect)) continue;
        if (!coveredEntityAspectPairs.has(`${entity}|${aspect}`)) {
          comparisonEntityAspectGain++;
        }
      }
    }
  }

  let aspectGain = 0;
  for (const aspect of candidateAspects) {
    if (requiredAspectSet.has(aspect) && !coveredAspects.has(aspect)) {
      aspectGain++;
    }
  }

  return { entityGain, comparisonEntityAspectGain, aspectGain };
}

function closesRequiredCoverageGap(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
): boolean {
  const gain = computeCoverageGain(
    candidate,
    selectedSoFar,
    comparisonLike,
    requiredEntitySet,
    requiredAspectSet,
  );
  return (
    gain.entityGain > 0 ||
    gain.comparisonEntityAspectGain > 0 ||
    gain.aspectGain > 0
  );
}

// ─── Selection Utility and Reasons ───────────────────────

function computeSelectionUtility(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
  sourceChunkCounts: Map<string, number>,
): number {
  const { entityGain, comparisonEntityAspectGain, aspectGain } =
    computeCoverageGain(
      candidate,
      selectedSoFar,
      comparisonLike,
      requiredEntitySet,
      requiredAspectSet,
    );

  let utility =
    WEIGHTS.requiredEntity * entityGain +
    WEIGHTS.comparisonEntityAspect * comparisonEntityAspectGain +
    WEIGHTS.requestedAspect * aspectGain +
    WEIGHTS.supportStrength * candidate.grade.supportStrength +
    WEIGHTS.hybridRelevance * candidate.relevance.score +
    WEIGHTS.quality * candidate.relevance.qualityScore;

  if ((sourceChunkCounts.get(candidate.chunk.sourceId) || 0) === 0) {
    utility += WEIGHTS.sourceDiversity;
  }

  // Content is preferred over snippet as a deterministic final tiebreak.
  utility +=
    0.001 * granularityScore(candidate.chunk.metadata.evidenceGranularity);

  return utility;
}

function computeSelectionReasons(
  candidate: GradedEvidenceChunk,
  selectedSoFar: GradedEvidenceChunk[],
  comparisonLike: boolean,
  requiredEntitySet: Set<string>,
  requiredAspectSet: Set<string>,
  sourceChunkCounts: Map<string, number>,
): string[] {
  const coveredEntities = new Set<string>();
  const coveredAspects = new Set<string>();
  const coveredEntityAspectPairs = new Set<string>();

  for (const selected of selectedSoFar) {
    for (const entity of selected.grade.entitySupport) {
      coveredEntities.add(entity.toLowerCase());
    }
    for (const aspect of selected.grade.aspectSupport) {
      coveredAspects.add(aspect);
    }
    if (comparisonLike && requiredEntitySet.size > 1) {
      for (const entity of selected.grade.entitySupport) {
        for (const aspect of selected.grade.aspectSupport) {
          coveredEntityAspectPairs.add(`${entity.toLowerCase()}|${aspect}`);
        }
      }
    }
  }

  const reasons: string[] = [];
  for (const entity of candidate.grade.entitySupport) {
    const canonicalEntity = entity.toLowerCase();
    if (
      requiredEntitySet.has(canonicalEntity) &&
      !coveredEntities.has(canonicalEntity)
    ) {
      reasons.push(`required_entity:${entity}`);
    }
  }

  if (comparisonLike && requiredEntitySet.size > 1) {
    for (const entity of candidate.grade.entitySupport) {
      const canonicalEntity = entity.toLowerCase();
      if (!requiredEntitySet.has(canonicalEntity)) continue;
      for (const aspect of candidate.grade.aspectSupport) {
        if (
          requiredAspectSet.has(aspect) &&
          !coveredEntityAspectPairs.has(`${canonicalEntity}|${aspect}`)
        ) {
          reasons.push(`entity_aspect:${entity}:${aspect}`);
        }
      }
    }
  }

  for (const aspect of candidate.grade.aspectSupport) {
    if (requiredAspectSet.has(aspect) && !coveredAspects.has(aspect)) {
      reasons.push(`requested_aspect:${aspect}`);
    }
  }

  if (candidate.grade.supportStrength >= 0.7) reasons.push("high_support");
  if ((sourceChunkCounts.get(candidate.chunk.sourceId) || 0) === 0) {
    reasons.push("source_diversity");
  }

  return [...new Set(reasons)];
}

/**
 * Deterministic ordering for the comparison entity-reservation phase:
 * entity×aspect cells, requested aspects, support, relevance, quality,
 * content over snippet, source diversity, then stable chunk identity.
 */
function compareReservationCandidates(
  a: GradedEvidenceChunk,
  b: GradedEvidenceChunk,
  entity: string,
  selectedSoFar: GradedEvidenceChunk[],
  requiredAspectSet: Set<string>,
  sourceChunkCounts: Map<string, number>,
): number {
  const coveredPairs = new Set<string>();
  const coveredAspects = new Set<string>();
  for (const selected of selectedSoFar) {
    for (const selectedEntity of selected.grade.entitySupport) {
      for (const aspect of selected.grade.aspectSupport) {
        coveredPairs.add(`${selectedEntity.toLowerCase()}|${aspect}`);
      }
    }
    for (const aspect of selected.grade.aspectSupport) {
      coveredAspects.add(aspect);
    }
  }

  const entityAspectGain = (candidate: GradedEvidenceChunk): number =>
    candidate.grade.aspectSupport.filter(
      (aspect) =>
        requiredAspectSet.has(aspect) &&
        !coveredPairs.has(`${entity.toLowerCase()}|${aspect}`),
    ).length;
  const requestedAspectGain = (candidate: GradedEvidenceChunk): number =>
    candidate.grade.aspectSupport.filter(
      (aspect) => requiredAspectSet.has(aspect) && !coveredAspects.has(aspect),
    ).length;
  const descending = (left: number, right: number): number => right - left;

  return (
    descending(entityAspectGain(a), entityAspectGain(b)) ||
    descending(requestedAspectGain(a), requestedAspectGain(b)) ||
    descending(a.grade.supportStrength, b.grade.supportStrength) ||
    descending(a.relevance.score, b.relevance.score) ||
    descending(a.relevance.qualityScore, b.relevance.qualityScore) ||
    descending(
      granularityScore(a.chunk.metadata.evidenceGranularity),
      granularityScore(b.chunk.metadata.evidenceGranularity),
    ) ||
    descending(
      (sourceChunkCounts.get(a.chunk.sourceId) || 0) === 0 ? 1 : 0,
      (sourceChunkCounts.get(b.chunk.sourceId) || 0) === 0 ? 1 : 0,
    ) ||
    a.chunk.id.localeCompare(b.chunk.id)
  );
}

// ─── Pack Coverage and Status ────────────────────────────

function recomputePackCoverage(
  packChunks: GradedEvidenceChunk[],
  retrievalContext: RetrievalContext,
): EvidenceCoverage {
  return computeEvidenceCoverage(packChunks, retrievalContext);
}

function derivePackStatus(
  packCoverage: EvidenceCoverage,
  packChunkCount: number,
): EvidencePackStatus {
  if (packChunkCount === 0) return "insufficient_evidence";
  if (packCoverage.missingEntities.length > 0) return "insufficient_evidence";
  if (packCoverage.missingAspects.length > 0) return "partially_grounded";

  if (packCoverage.comparisonLike) {
    for (const entityAspect of packCoverage.entityAspectCoverage) {
      if (entityAspect.missingAspects.length > 0) {
        return "partially_grounded";
      }
    }
  }

  return "grounded";
}

// ─── Source Correspondence and Final Invariants ───────────

function buildResolverSourceMap(
  resolvedSources: SourceItem[],
): Map<string, SourceItem> {
  const sourceMap = new Map<string, SourceItem>();
  for (const source of resolvedSources) {
    sourceMap.set(source.feed_item_id, source);
  }
  return sourceMap;
}

/**
 * Final fail-closed pass. A packed chunk must map to an exact resolver source,
 * and canonical URL dedupe may not leave a chunk pointing at an omitted source.
 * This pass also re-enforces every hard pack limit without truncating text.
 */
function enforceFinalPackInvariants(params: {
  selected: GradedEvidenceChunk[];
  resolvedSourceMap: Map<string, SourceItem>;
  comparisonLike: boolean;
  requiredEntitySet: Set<string>;
  requiredAspectSet: Set<string>;
  droppedForBudget: Set<string>;
  droppedForPerSourceLimit: Set<string>;
}): GradedEvidenceChunk[] {
  const {
    selected,
    resolvedSourceMap,
    comparisonLike,
    requiredEntitySet,
    requiredAspectSet,
    droppedForBudget,
    droppedForPerSourceLimit,
  } = params;
  const finalSelected: GradedEvidenceChunk[] = [];
  const finalSourceCounts = new Map<string, number>();
  const canonicalSourceIds = new Map<string, string>();
  let totalChars = 0;

  for (const candidate of selected) {
    const source = resolvedSourceMap.get(candidate.chunk.sourceId);
    if (!source) continue;

    const canonicalUrl = canonicalizeUrl(source.url || "");
    if (!canonicalUrl) continue;
    const existingSourceId = canonicalSourceIds.get(canonicalUrl);
    if (existingSourceId && existingSourceId !== candidate.chunk.sourceId) {
      continue;
    }

    if (finalSelected.length >= MAX_PACK_CHUNKS) continue;
    if (candidate.chunk.text.length + totalChars > MAX_PACK_CHARS) {
      droppedForBudget.add(candidate.chunk.id);
      continue;
    }

    const sourceCount = finalSourceCounts.get(candidate.chunk.sourceId) || 0;
    const closesGap = closesRequiredCoverageGap(
      candidate,
      finalSelected,
      comparisonLike,
      requiredEntitySet,
      requiredAspectSet,
    );
    if (
      sourceCount >= HARD_MAX_CHUNKS_PER_SOURCE ||
      (sourceCount === MAX_CHUNKS_PER_SOURCE && !closesGap)
    ) {
      droppedForPerSourceLimit.add(candidate.chunk.id);
      continue;
    }

    // These checks are intentionally repeated at the final boundary.
    if (!candidate.grade.relevant) continue;
    if (candidate.grade.supportStrength < TRUST_THRESHOLD) continue;
    if (candidate.chunk.metadata.evidenceGranularity === "metadata_only") continue;

    finalSelected.push(candidate);
    totalChars += candidate.chunk.text.length;
    finalSourceCounts.set(
      candidate.chunk.sourceId,
      sourceCount + 1,
    );
    canonicalSourceIds.set(canonicalUrl, candidate.chunk.sourceId);
  }

  return finalSelected;
}

function buildPackSourceSet(
  selected: GradedEvidenceChunk[],
  resolvedSourceMap: Map<string, SourceItem>,
): SourceItem[] {
  const sources: SourceItem[] = [];
  const seenSourceIds = new Set<string>();
  for (const chunk of selected) {
    if (seenSourceIds.has(chunk.chunk.sourceId)) continue;
    const source = resolvedSourceMap.get(chunk.chunk.sourceId);
    if (!source) continue;
    sources.push(source);
    seenSourceIds.add(chunk.chunk.sourceId);
  }
  return sources;
}

// ─── Upgrade Guard ───────────────────────────────────────

function enforceUpgradeGuard(
  packCoverage: EvidenceCoverage,
  retrievalCoverage: EvidenceCoverage,
): EvidenceCoverage {
  const retrievalEntitySet = new Set(
    retrievalCoverage.coveredEntities.map((entity) => entity.toLowerCase()),
  );
  const validCoveredEntities = packCoverage.coveredEntities.filter((entity) =>
    retrievalEntitySet.has(entity.toLowerCase()),
  );
  const validMissingEntities = packCoverage.requiredEntities.filter(
    (entity) =>
      !validCoveredEntities.some(
        (covered) => covered.toLowerCase() === entity.toLowerCase(),
      ),
  );

  const retrievalAspectSet = new Set(retrievalCoverage.coveredAspects);
  const validCoveredAspects = packCoverage.coveredAspects.filter((aspect) =>
    retrievalAspectSet.has(aspect),
  );
  const validMissingAspects = packCoverage.requiredAspects.filter(
    (aspect) => !validCoveredAspects.includes(aspect),
  );

  const retrievalEntityAspectPairs = new Set<string>();
  for (const entityAspect of retrievalCoverage.entityAspectCoverage) {
    for (const aspect of entityAspect.coveredAspects) {
      retrievalEntityAspectPairs.add(
        `${entityAspect.entity.toLowerCase()}|${aspect}`,
      );
    }
  }

  const validEntityAspectCoverage = packCoverage.entityAspectCoverage.map(
    (entityAspect) => {
      const validCovered = entityAspect.coveredAspects.filter((aspect) =>
        retrievalEntityAspectPairs.has(
          `${entityAspect.entity.toLowerCase()}|${aspect}`,
        ),
      );
      const validMissing = packCoverage.requiredAspects.filter(
        (aspect) => !validCovered.includes(aspect),
      );
      return {
        entity: entityAspect.entity,
        coveredAspects: validCovered,
        missingAspects: validMissing,
      };
    },
  );

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

  const trustedCandidates = filterTrustedCandidates(gradedChunks);
  const selected: GradedEvidenceChunk[] = [];
  const remainingCandidates = [...trustedCandidates];
  const sourceChunkCounts = new Map<string, number>();
  const selectionReasons = new Map<string, string[]>();
  const requiredEntitySet = new Set(
    retrievalContext.primaryEntities
      .filter((entity) => entity.required)
      .map((entity) => entity.canonical.toLowerCase()),
  );
  const requiredAspectSet = new Set(retrievalContext.requestedAspects);
  const comparisonLike = retrievalCoverage.comparisonLike;
  const resolvedSourceMap = buildResolverSourceMap(resolvedSources);

  const droppedForBudget = new Set<string>();
  const droppedForRedundancy = new Set<string>();
  const droppedForPerSourceLimit = new Set<string>();
  const tokenCache = new Map<string, string[]>();
  let totalChars = 0;

  const getCandidateTokens = (candidate: GradedEvidenceChunk): string[] => {
    // Stable chunk identity is the cache key; text prefixes can collide.
    const key = candidate.chunk.id;
    const cached = tokenCache.get(key);
    if (cached) return cached;
    const tokens = normalizeTokens(candidate.chunk.text);
    tokenCache.set(key, tokens);
    return tokens;
  };

  const isRedundant = (candidate: GradedEvidenceChunk): boolean => {
    const candidateTokens = getCandidateTokens(candidate);
    return selected.some(
      (selectedChunk) =>
        jaccardSimilarity(candidateTokens, getCandidateTokens(selectedChunk)) >
        REDUNDANCY_THRESHOLD,
    );
  };

  /**
   * Evaluate all deterministic rejection rules for one scoring attempt.
   * A candidate may be recorded in multiple unique categories, but a category
   * can never count the same chunk more than once.
   */
  const canSelectCandidate = (candidate: GradedEvidenceChunk): boolean => {
    const sourceCount = sourceChunkCounts.get(candidate.chunk.sourceId) || 0;
    const closesGap = closesRequiredCoverageGap(
      candidate,
      selected,
      comparisonLike,
      requiredEntitySet,
      requiredAspectSet,
    );
    const sourceLimitRejected =
      sourceCount >= HARD_MAX_CHUNKS_PER_SOURCE ||
      (sourceCount === MAX_CHUNKS_PER_SOURCE && !closesGap);
    if (sourceLimitRejected) {
      droppedForPerSourceLimit.add(candidate.chunk.id);
    }

    const budgetRejected = totalChars + candidate.chunk.text.length > MAX_PACK_CHARS;
    if (budgetRejected) droppedForBudget.add(candidate.chunk.id);

    const redundancyRejected = isRedundant(candidate) && !closesGap;
    if (redundancyRejected) droppedForRedundancy.add(candidate.chunk.id);

    return !sourceLimitRejected && !budgetRejected && !redundancyRejected;
  };

  const selectCandidate = (candidate: GradedEvidenceChunk): void => {
    const reasons = computeSelectionReasons(
      candidate,
      selected,
      comparisonLike,
      requiredEntitySet,
      requiredAspectSet,
      sourceChunkCounts,
    );
    selectionReasons.set(candidate.chunk.id, reasons);
    selected.push(candidate);
    totalChars += candidate.chunk.text.length;
    sourceChunkCounts.set(
      candidate.chunk.sourceId,
      (sourceChunkCounts.get(candidate.chunk.sourceId) || 0) + 1,
    );
    const index = remainingCandidates.indexOf(candidate);
    if (index >= 0) remainingCandidates.splice(index, 1);
  };

  // ── Phase A: deterministic comparison entity reservation ──
  if (comparisonLike && requiredEntitySet.size > 1) {
    for (const requiredEntity of requiredEntitySet) {
      const alreadyCovered = selected.some((candidate) =>
        candidate.grade.entitySupport.some(
          (entity) => entity.toLowerCase() === requiredEntity,
        ),
      );
      if (alreadyCovered || selected.length >= MAX_PACK_CHUNKS) continue;

      const reservationCandidates = remainingCandidates
        .filter((candidate) =>
          candidate.grade.entitySupport.some(
            (entity) => entity.toLowerCase() === requiredEntity,
          ),
        )
        .sort((a, b) =>
          compareReservationCandidates(
            a,
            b,
            requiredEntity,
            selected,
            requiredAspectSet,
            sourceChunkCounts,
          ),
        );

      for (const candidate of reservationCandidates) {
        if (!canSelectCandidate(candidate)) continue;
        selectCandidate(candidate);
        break;
      }
    }
  }

  // ── Phase B: coverage-first greedy selection ────────────
  while (selected.length < MAX_PACK_CHUNKS && remainingCandidates.length > 0) {
    let bestCandidate: GradedEvidenceChunk | undefined;
    let bestUtility = -Infinity;

    for (const candidate of remainingCandidates) {
      if (!canSelectCandidate(candidate)) continue;
      const utility = computeSelectionUtility(
        candidate,
        selected,
        comparisonLike,
        requiredEntitySet,
        requiredAspectSet,
        sourceChunkCounts,
      );
      if (
        utility > bestUtility ||
        (utility === bestUtility &&
          (!bestCandidate || candidate.chunk.id.localeCompare(bestCandidate.chunk.id) < 0))
      ) {
        bestCandidate = candidate;
        bestUtility = utility;
      }
    }

    if (!bestCandidate) break;
    selectCandidate(bestCandidate);
  }

  // ── Final fail-closed pruning and recomputation ─────────
  const finalSelected = enforceFinalPackInvariants({
    selected,
    resolvedSourceMap,
    comparisonLike,
    requiredEntitySet,
    requiredAspectSet,
    droppedForBudget,
    droppedForPerSourceLimit,
  });

  const packChunks: EvidencePackChunk[] = finalSelected.map((graded) => ({
    chunkId: graded.chunk.id,
    sourceId: graded.chunk.sourceId,
    text: graded.chunk.text,
    title: graded.chunk.metadata.title,
    url: graded.chunk.metadata.url,
    canonicalUrl: graded.chunk.metadata.canonicalUrl,
    domain: graded.chunk.metadata.domain,
    publishedAt: graded.chunk.metadata.publishedAt,
    evidenceGranularity: graded.chunk.metadata.evidenceGranularity,
    entitySupport: graded.grade.entitySupport,
    aspectSupport: graded.grade.aspectSupport,
    lockedPhraseSupport: graded.relevance.lockedPhraseSupport,
    supportStrength: graded.grade.supportStrength,
    hybridScore: graded.relevance.score,
    qualityScore: graded.relevance.qualityScore,
    gradingMode: graded.grade.gradingMode as "llm" | "deterministic_fallback",
    selectionReasons: [
      ...new Set(selectionReasons.get(graded.chunk.id) || []),
    ],
  }));

  const totalCharsFinal = finalSelected.reduce(
    (total, chunk) => total + chunk.chunk.text.length,
    0,
  );
  let packCoverage = recomputePackCoverage(finalSelected, retrievalContext);
  packCoverage = enforceUpgradeGuard(packCoverage, retrievalCoverage);
  const status = derivePackStatus(packCoverage, finalSelected.length);
  const sources = buildPackSourceSet(finalSelected, resolvedSourceMap);

  const diagnostics = {
    candidateChunkCount: trustedCandidates.length,
    selectedChunkCount: finalSelected.length,
    selectedSourceCount: sources.length,
    droppedForBudget: droppedForBudget.size,
    droppedForRedundancy: droppedForRedundancy.size,
    droppedForPerSourceLimit: droppedForPerSourceLimit.size,
  };

  console.log(
    JSON.stringify({
      log: "[evidence-pack] built",
      pack_status: status,
      candidate_chunks: diagnostics.candidateChunkCount,
      selected_chunks: diagnostics.selectedChunkCount,
      selected_sources: diagnostics.selectedSourceCount,
      total_chars: totalCharsFinal,
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
    totalChars: totalCharsFinal,
    selectionDiagnostics: diagnostics,
  };
}
