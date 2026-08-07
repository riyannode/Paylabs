/**
 * Evidence Retrieval with Coverage Retry
 *
 * Wires commits 3–6 helpers into one bounded evidence retrieval pipeline:
 *   canonical SourceItems → content fetch → documents → chunks → hybrid rank
 *   → evidence grade → evidence-level coverage → targeted retry for missing coverage
 *
 * This is INTERNAL RAG infrastructure. NOT a new agent or service.
 * Creates NO x402/payment edge.
 *
 * Retry uses internal Tavily live search (NOT paid signal_scout).
 * All retry candidates pass canonical resolveSources() before processing.
 */

import type { RetrievalContext, SourceItem } from "../sources/types";
import type { RouteTier } from "@/lib/paylabs/route-tier";
import type {
  EvidenceChunk,
  EvidenceCoverage,
  EvidenceRetryRound,
  EvidenceRetrievalResult,
  GradedEvidenceChunk,
  RankedEvidenceChunk,
} from "./types";
import { buildEvidenceDocuments } from "./document-builder";
import { chunkEvidenceDocuments } from "./chunker";
import { rankEvidenceChunks } from "./hybrid-ranker";
import { gradeEvidenceChunks } from "./evidence-grader";
import { ASPECT_DEFINITIONS } from "../sources/crypto-entity-registry";

// ─── Configuration ─────────────────────────────────────────

const RETRIEVAL_CONFIG = {
  /** Maximum retry rounds for missing coverage */
  maxRetryRounds: 2,
  /** Maximum targeted queries per retry round */
  maxQueriesPerRound: 3,
  /** Maximum total unique resolved sources across all rounds */
  maxTotalSources: 15,
  /** Maximum total graded chunks across all rounds */
  maxTotalGradedChunks: 120,
  /** Overall evidence retrieval deadline in ms (~65s, safe within 300s route max) */
  retrievalDeadlineMs: 65_000,
  /** Minimum supportStrength to count a chunk as covering an entity/aspect */
  coverageTrustThreshold: 0.25,
} as const;

// ─── Comparison Detection ──────────────────────────────────

/**
 * Deterministic detection of comparison-style queries.
 * No LLM involved.
 */
function detectComparisonLike(retrievalContext: RetrievalContext): boolean {
  const intent = retrievalContext.intentType?.toLowerCase() || "";
  if (intent.includes("comparison") || intent.includes("compare")) return true;

  const goal = retrievalContext.originalGoal.toLowerCase();
  const comparisonPatterns = [
    /\bvs\b/,
    /\bversus\b/,
    /\bcompare\b/,
    /\bdifference\b/,
    /\bbetween\b.*\band\b/,
  ];
  return comparisonPatterns.some((p) => p.test(goal));
}

// ─── Evidence Coverage Computation ─────────────────────────

/**
 * Compute evidence coverage from graded chunks.
 * Coverage authority is graded chunk support — NOT raw relevance.
 * Only chunks with grade.relevant=true AND supportStrength >= threshold count.
 */
export function computeEvidenceCoverage(
  gradedChunks: GradedEvidenceChunk[],
  retrievalContext: RetrievalContext,
): EvidenceCoverage {
  const requiredEntities = retrievalContext.primaryEntities
    .filter((e) => e.required)
    .map((e) => e.canonical);
  const requiredAspects = retrievalContext.requestedAspects;
  const comparisonLike = detectComparisonLike(retrievalContext);

  const coveredEntitySet = new Set<string>();
  const coveredAspectSet = new Set<string>();

  // Per-entity × aspect tracking for comparison queries
  const entityAspectMap = new Map<string, { covered: Set<string>; all: Set<string> }>();

  for (const gc of gradedChunks) {
    if (!gc.grade.relevant) continue;
    if (gc.grade.supportStrength < RETRIEVAL_CONFIG.coverageTrustThreshold) continue;

    // Entity coverage
    for (const entity of gc.grade.entitySupport) {
      const canonical = entity.toLowerCase();
      if (requiredEntities.some((re) => re.toLowerCase() === canonical)) {
        coveredEntitySet.add(canonical);
      }
    }

    // Aspect coverage
    for (const aspect of gc.grade.aspectSupport) {
      if (requiredAspects.includes(aspect)) {
        coveredAspectSet.add(aspect);
      }
    }

    // Per-entity × aspect for comparison queries
    if (comparisonLike && requiredEntities.length > 1) {
      for (const entity of gc.grade.entitySupport) {
        const canonical = entity.toLowerCase();
        if (!requiredEntities.some((re) => re.toLowerCase() === canonical)) continue;

        if (!entityAspectMap.has(canonical)) {
          entityAspectMap.set(canonical, { covered: new Set(), all: new Set(requiredAspects) });
        }
        const entry = entityAspectMap.get(canonical)!;
        for (const aspect of gc.grade.aspectSupport) {
          if (requiredAspects.includes(aspect)) {
            entry.covered.add(aspect);
          }
        }
      }
    }
  }

  const coveredEntities = requiredEntities.filter((e) =>
    coveredEntitySet.has(e.toLowerCase()),
  );
  const missingEntities = requiredEntities.filter(
    (e) => !coveredEntitySet.has(e.toLowerCase()),
  );
  const coveredAspects = requiredAspects.filter((a) => coveredAspectSet.has(a));
  const missingAspects = requiredAspects.filter((a) => !coveredAspectSet.has(a));

  // Build entity × aspect coverage matrix
  const entityAspectCoverage: EvidenceCoverage["entityAspectCoverage"] = [];
  if (comparisonLike && requiredEntities.length > 1) {
    for (const entity of requiredEntities) {
      const canonical = entity.toLowerCase();
      const entry = entityAspectMap.get(canonical);
      const covered = entry ? [...entry.covered] : [];
      const missing = requiredAspects.filter((a) => !covered.includes(a));
      entityAspectCoverage.push({ entity, coveredAspects: covered, missingAspects: missing });
    }
  }

  return {
    requiredEntities,
    coveredEntities,
    missingEntities,
    requiredAspects,
    coveredAspects,
    missingAspects,
    comparisonLike,
    entityAspectCoverage,
  };
}

/**
 * Check if coverage is complete for the given retrieval context.
 */
function isCoverageComplete(coverage: EvidenceCoverage): boolean {
  if (coverage.missingEntities.length > 0) return false;
  if (coverage.missingAspects.length > 0) return false;

  // For comparison queries, also check entity × aspect matrix
  if (coverage.comparisonLike) {
    for (const eac of coverage.entityAspectCoverage) {
      if (eac.missingAspects.length > 0) return false;
    }
  }

  return true;
}

// ─── Targeted Query Generation ─────────────────────────────

/**
 * Humanize an aspect key into a search-friendly phrase.
 * Uses ASPECT_DEFINITIONS.label when available.
 */
function humanizeAspect(aspectKey: string): string {
  const def = ASPECT_DEFINITIONS[aspectKey];
  if (def?.label) return def.label;
  // Fallback: snake_case → space-separated
  return aspectKey.replace(/_/g, " ");
}

/**
 * Extract freshness signals from the original query (year, "current", etc.)
 */
function extractFreshnessSignals(originalGoal: string): string {
  const yearMatch = originalGoal.match(/\b(20[2-3]\d)\b/);
  if (yearMatch) return yearMatch[1];

  const lower = originalGoal.toLowerCase();
  if (lower.includes("current")) return "current";
  if (lower.includes("latest")) return "latest";
  if (lower.includes("recent")) return "recent";

  return "";
}

/**
 * Generate targeted retry queries from missing coverage.
 * Deterministic — no LLM involved.
 *
 * Priority:
 *   A. Missing required entity
 *   B. Missing entity/aspect pair in comparison
 *   C. Globally missing requested aspect
 */
function generateTargetedRetryQueries(
  coverage: EvidenceCoverage,
  originalGoal: string,
  maxQueries: number,
): string[] {
  const queries: string[] = [];
  const freshness = extractFreshnessSignals(originalGoal);

  // Priority A: Missing required entity (global)
  for (const entity of coverage.missingEntities) {
    if (queries.length >= maxQueries) break;
    const q = [entity, ...coverage.missingAspects.map(humanizeAspect)];
    if (freshness) q.push(freshness);
    queries.push(q.join(" "));
  }

  // Priority B: Missing entity/aspect pair in comparison
  if (coverage.comparisonLike && coverage.entityAspectCoverage.length > 0) {
    for (const eac of coverage.entityAspectCoverage) {
      if (queries.length >= maxQueries) break;
      if (eac.missingAspects.length === 0) continue;

      // Generate one query per missing aspect for this entity
      for (const aspect of eac.missingAspects) {
        if (queries.length >= maxQueries) break;
        const q = [eac.entity, humanizeAspect(aspect)];
        if (freshness) q.push(freshness);
        queries.push(q.join(" "));
      }
    }
  }

  // Priority C: Globally missing aspect (if not already covered by B)
  for (const aspect of coverage.missingAspects) {
    if (queries.length >= maxQueries) break;
    // Skip if already generated via entity/aspect pairs
    const aspectPhrase = humanizeAspect(aspect);
    if (queries.some((q) => q.includes(aspectPhrase))) continue;

    const q = [...coverage.requiredEntities.slice(0, 2), aspectPhrase];
    if (freshness) q.push(freshness);
    queries.push(q.join(" "));
  }

  return queries.slice(0, maxQueries);
}

// ─── Tavily Retry Provider ─────────────────────────────────

/**
 * Fetch targeted Tavily candidates for a retry round.
 * Returns raw candidates — caller must pass through canonical resolver.
 */
async function fetchRetryTavilyCandidates(
  queries: string[],
  retrievalContext: RetrievalContext,
  callerTag: string,
): Promise<Array<{
  feed_item_id: string;
  title: string;
  publisher: string;
  source_kind: "tavily_live";
  provider: "tavily";
  source_url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  route_path: null;
  reason: string;
  rank: number;
  relevance_score: number;
}>> {
  try {
    const { isTavilyEnabled, fetchTavilyLiveSources } = await import(
      "../web-search/tavily-live-search"
    );
    if (!isTavilyEnabled()) return [];

    const allCandidates: Array<{
      feed_item_id: string;
      title: string;
      publisher: string;
      source_kind: "tavily_live";
      provider: "tavily";
      source_url: string;
      domain: string | null;
      summary: string;
      author: string;
      published_at: string | null;
      route_path: null;
      reason: string;
      rank: number;
      relevance_score: number;
    }> = [];

    for (const query of queries) {
      try {
        // Build entity terms from the query itself + original context
        const queryTerms = query.split(/\s+/).filter((t) => t.length > 2);
        const entityTerms = [
          ...new Set([
            ...retrievalContext.entityTerms.slice(0, 5),
            ...queryTerms.slice(0, 4),
          ]),
        ];

        const result = await fetchTavilyLiveSources({
          userGoal: query,
          entityTerms,
          topicCategory: "general",
          callerTag,
        });

        allCandidates.push(
          ...result.candidates.map((c) => ({
            feed_item_id: c.feed_item_id,
            title: c.title,
            publisher: c.publisher,
            source_kind: "tavily_live" as const,
            provider: "tavily" as const,
            source_url: c.source_url || "",
            domain: c.domain || null,
            summary: c.summary || "",
            author: c.author || "",
            published_at: c.published_at || null,
            route_path: null as null,
            reason: c.reason || "",
            rank: c.rank,
            relevance_score: c.relevance_score,
          })),
        );
      } catch {
        // Individual query failure — continue with others
      }
    }

    return allCandidates;
  } catch {
    // Tavily unavailable
    return [];
  }
}

type TavilyRetryCandidate = {
  feed_item_id: string;
  title: string;
  publisher: string;
  source_kind: "tavily_live";
  provider: "tavily";
  source_url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  route_path: null;
  reason: string;
  rank: number;
  relevance_score: number;
};

/**
 * Dedupe candidates by canonical URL against already-processed URLs.
 */
function dedupeCandidates(
  candidates: TavilyRetryCandidate[],
  existingUrls: Set<string>,
): TavilyRetryCandidate[] {
  const seen = new Set(existingUrls);
  const deduped: TavilyRetryCandidate[] = [];

  for (const c of candidates) {
    const url = c.source_url?.toLowerCase().replace(/\/+$/, "") || "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    deduped.push(c);
  }

  return deduped;
}

// ─── Main Orchestrator ─────────────────────────────────────

/**
 * Run evidence retrieval with coverage-aware bounded retry.
 *
 * First pass:
 *   initial canonical SourceItem[] → documents → chunks → rank → grade → coverage
 *
 * Then bounded retry rounds for missing coverage using targeted Tavily queries.
 *
 * Returns EvidenceRetrievalResult with all graded evidence and coverage metadata.
 */
export async function runEvidenceRetrievalWithCoverage(params: {
  retrievalContext: RetrievalContext;
  initialSources: SourceItem[];
  delegatedRouteTier: string;
}): Promise<EvidenceRetrievalResult> {
  const { retrievalContext, initialSources, delegatedRouteTier } = params;

  // No retrieval context → nothing to do
  if (!retrievalContext || !retrievalContext.originalGoal) {
    return {
      gradedChunks: [],
      resolvedSources: [],
      coverage: {
        requiredEntities: [],
        coveredEntities: [],
        missingEntities: [],
        requiredAspects: [],
        coveredAspects: [],
        missingAspects: [],
        comparisonLike: false,
        entityAspectCoverage: [],
      },
      retryRounds: [],
      retryQueries: [],
      stoppedReason: "no_retrieval_context",
    };
  }

  // Convert external tier to internal tier for evidence grader
  const { toInternalTier } = await import("@/lib/paylabs/route-tier");
  const internalRouteTier = toInternalTier(delegatedRouteTier);

  const deadline = Date.now() + RETRIEVAL_CONFIG.retrievalDeadlineMs;
  const allGradedChunks: GradedEvidenceChunk[] = [];
  const allResolvedSources: SourceItem[] = [...initialSources];
  const processedUrls = new Set(
    initialSources.map((s) => s.url?.toLowerCase().replace(/\/+$/, "") || ""),
  );
  const retryRounds: EvidenceRetryRound[] = [];
  const retryQueries: string[] = [];
  let stoppedReason: EvidenceRetrievalResult["stoppedReason"] = "deadline";

  // ── First pass: initial sources → documents → chunks → rank → grade ──
  try {
    const documents = await buildEvidenceDocuments(initialSources);
    const chunks = await chunkEvidenceDocuments(documents);
    const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);

    const gradingResult = await gradeEvidenceChunks({
      retrievalContext,
      rankedChunks,
      routeTier: internalRouteTier,
    });

    allGradedChunks.push(...gradingResult.chunks);
  } catch (err: unknown) {
    console.error("[evidence-retrieval] first pass failed", {
      error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150),
    });
  }

  // ── Compute initial coverage ──
  let coverage = computeEvidenceCoverage(allGradedChunks, retrievalContext);

  if (isCoverageComplete(coverage)) {
    return {
      gradedChunks: allGradedChunks,
      resolvedSources: allResolvedSources,
      coverage,
      retryRounds,
      retryQueries,
      stoppedReason: "coverage_complete",
    };
  }

  // ── Bounded retry rounds ──
  for (let round = 1; round <= RETRIEVAL_CONFIG.maxRetryRounds; round++) {
    // Budget checks
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }
    if (allResolvedSources.length >= RETRIEVAL_CONFIG.maxTotalSources) {
      stoppedReason = "retry_limit";
      break;
    }
    if (allGradedChunks.length >= RETRIEVAL_CONFIG.maxTotalGradedChunks) {
      stoppedReason = "retry_limit";
      break;
    }

    // Generate targeted queries
    const queries = generateTargetedRetryQueries(
      coverage,
      retrievalContext.originalGoal,
      RETRIEVAL_CONFIG.maxQueriesPerRound,
    );
    retryQueries.push(...queries);

    if (queries.length === 0) {
      stoppedReason = "coverage_complete";
      break;
    }

    const coverageBefore = { ...coverage };

    // Fetch Tavily candidates
    const rawCandidates = await fetchRetryTavilyCandidates(
      queries,
      retrievalContext,
      `evidence_retry_round_${round}`,
    );

    if (rawCandidates.length === 0) {
      // Provider unavailable or no results
      if (round === 1) {
        stoppedReason = "provider_unavailable";
      } else {
        stoppedReason = "no_new_sources";
      }
      break;
    }

    // Dedupe against existing sources
    const newCandidates = dedupeCandidates(rawCandidates, processedUrls);

    if (newCandidates.length === 0) {
      stoppedReason = "no_new_sources";
      break;
    }

    // Pass through canonical resolver
    let newSources: SourceItem[] = [];
    try {
      const { resolveSources } = await import("../sources/source-resolver");
      const resolverResult = await resolveSources({
        rankedCandidates: newCandidates.map((c) => ({
          feed_item_id: c.feed_item_id,
          rank: c.rank,
          relevance_score: c.relevance_score,
          source_kind: "tavily_live" as const,
          provider: "tavily" as const,
          source_url: c.source_url,
          title: c.title,
          domain: c.domain,
          summary: c.summary,
          author: c.author,
          published_at: c.published_at,
          route_path: c.route_path,
          reason: c.reason,
        })),
        retrievalContext,
        normalizedGoal: retrievalContext.normalizedGoal,
        entityTerms: retrievalContext.entityTerms,
        primaryEntities: retrievalContext.primaryEntities,
        secondaryEntities: retrievalContext.secondaryEntities,
        negativeEntities: retrievalContext.negativeEntities,
        lockedPhrases: retrievalContext.lockedPhrases,
        topics: retrievalContext.topics,
        requestedAspects: retrievalContext.requestedAspects,
        maxSources: Math.min(
          RETRIEVAL_CONFIG.maxTotalSources - allResolvedSources.length,
          5,
        ),
      });

      if (resolverResult.ok && resolverResult.sourceContext.source_count > 0) {
        newSources = resolverResult.sourceContext.sources_used;
      }
    } catch {
      // Resolver failed — continue with what we have
    }

    // Track new URLs
    for (const s of newSources) {
      const url = s.url?.toLowerCase().replace(/\/+$/, "") || "";
      if (url) processedUrls.add(url);
    }

    // Content fetch → chunk → rank → grade new sources
    let newGradedChunks: GradedEvidenceChunk[] = [];
    try {
      const documents = await buildEvidenceDocuments(newSources);
      const chunks = await chunkEvidenceDocuments(documents);
      const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);

      const gradingResult = await gradeEvidenceChunks({
        retrievalContext,
        rankedChunks,
        routeTier: internalRouteTier,
      });

      newGradedChunks = gradingResult.chunks;
    } catch {
      // Fetch/chunk/rank/grade failed for this round — continue
    }

    allGradedChunks.push(...newGradedChunks);
    allResolvedSources.push(...newSources);

    // Recompute coverage
    coverage = computeEvidenceCoverage(allGradedChunks, retrievalContext);

    retryRounds.push({
      round,
      queries,
      candidateCount: rawCandidates.length,
      resolvedSourceCount: newSources.length,
      newSourceCount: newSources.filter(
        (s) => !initialSources.some((is) => is.url === s.url),
      ).length,
      coverageBefore,
      coverageAfter: { ...coverage },
    });

    if (isCoverageComplete(coverage)) {
      stoppedReason = "coverage_complete";
      break;
    }
  }

  return {
    gradedChunks: allGradedChunks,
    resolvedSources: allResolvedSources,
    coverage,
    retryRounds,
    retryQueries,
    stoppedReason,
  };
}
