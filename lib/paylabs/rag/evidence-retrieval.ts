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
  RetrievalFailureReasonCode,
} from "./types";
import { buildEvidenceDocuments } from "./document-builder";
import { chunkEvidenceDocuments } from "./chunker";
import { rankEvidenceChunks } from "./hybrid-ranker";
import { gradeEvidenceChunks } from "./evidence-grader";
import { ASPECT_DEFINITIONS } from "../sources/crypto-entity-registry";
import {
  appendHardTemporalScope,
  evaluateTemporalConstraint,
  extractQueryRequirements,
} from "../sources/query-requirements";
import { canonicalizeUrl } from "../sources/source-resolver";

// ─── Configuration ─────────────────────────────────────────

const RETRIEVAL_CONFIG = {
  /** Maximum retry rounds for missing coverage (includes ALL additional rounds) */
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
  if (retrievalContext.queryRequirements?.comparisonLike) return true;
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
  now: Date = new Date(),
): EvidenceCoverage {
  const requirements = retrievalContext.queryRequirements ?? extractQueryRequirements(retrievalContext.originalGoal);
  const requiredEntities = requirements.explicitSubjects
    .filter((subject) => subject.required)
    .map((subject) => subject.canonical);
  const requiredAspects = requirements.requestedAspects.map((aspect) => aspect.key);
  const comparisonLike = requirements.comparisonLike;

  const coveredEntitySet = new Set<string>();
  const coveredAspectSet = new Set<string>();

  // Per-entity × aspect tracking for comparison queries
  const entityAspectMap = new Map<string, { covered: Set<string>; all: Set<string> }>();

  // Count trusted evidence chunks
  let trustedEvidenceCount = 0;
  let inWindowTrustedEvidenceCount = 0;
  let temporalEligibleTrustedEvidenceCount = 0;

  for (const gc of gradedChunks) {
    if (!gc.grade.relevant) continue;
    if (gc.grade.supportStrength < RETRIEVAL_CONFIG.coverageTrustThreshold) continue;

    // This chunk qualifies as trusted evidence
    trustedEvidenceCount++;
    const temporal = evaluateTemporalConstraint(
      gc.chunk.metadata.publishedAt,
      requirements.temporalConstraint,
      now,
    );
    const coverageEligible = !requirements.temporalConstraint?.hard || temporal.inWindow;
    if (temporal.inWindow) {
      inWindowTrustedEvidenceCount++;
    }
    if (coverageEligible) temporalEligibleTrustedEvidenceCount++;
    if (!coverageEligible) continue;

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

  const temporalCoverageOk = !requirements.temporalConstraint?.hard || inWindowTrustedEvidenceCount > 0;
  const failureReasonCodes: RetrievalFailureReasonCode[] = [];
  if (missingEntities.length > 0 || missingAspects.length > 0) failureReasonCodes.push("retrieval_requirement_coverage_missing");
  if (comparisonLike && entityAspectCoverage.some((row) => row.coveredAspects.length === 0)) failureReasonCodes.push("retrieval_entity_imbalance");
  if (requirements.temporalConstraint?.hard && !temporalCoverageOk) failureReasonCodes.push("retrieval_temporal_mismatch");

  return {
    requiredEntities,
    coveredEntities,
    missingEntities,
    requiredAspects,
    coveredAspects,
    missingAspects,
    comparisonLike,
    entityAspectCoverage,
    temporalCoverageOk,
    failureReasonCodes,
    inWindowTrustedEvidenceCount,
    temporalEligibleTrustedEvidenceCount,
    temporalConstraint: requirements.temporalConstraint
      ? {
          kind: requirements.temporalConstraint.kind,
          hard: requirements.temporalConstraint.hard,
          value: requirements.temporalConstraint.value,
          unit: requirements.temporalConstraint.unit,
          start: requirements.temporalConstraint.start,
          end: requirements.temporalConstraint.end,
        }
      : null,
    requirementsValid: requirements.requirementsValid,
    requirementsWarnings: requirements.extractionWarnings,
    trustedEvidenceCount,
  };
}

/**
 * Check if coverage is complete for the given retrieval context.
 * Requires temporal-eligible trusted evidence > 0 — old/undated evidence
 * cannot make a hard temporal query complete.
 */
function isCoverageComplete(
  coverage: EvidenceCoverage,
  retrievalContext: RetrievalContext,
): boolean {
  const requirements = retrievalContext.queryRequirements ?? extractQueryRequirements(retrievalContext.originalGoal);
  if (!requirements.requirementsValid) return false;
  if (!coverage.temporalCoverageOk) return false;
  if (coverage.temporalEligibleTrustedEvidenceCount === 0) return false;

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
  temporalConstraint: ReturnType<typeof extractQueryRequirements>["temporalConstraint"],
  maxQueries: number,
): string[] {
  const queries: string[] = [];
  const freshness = extractFreshnessSignals(originalGoal);

  // Priority A: Missing required entity (global)
  for (const entity of coverage.missingEntities) {
    if (queries.length >= maxQueries) break;
    const q = [entity, ...coverage.missingAspects.map(humanizeAspect)];
    if (freshness) q.push(freshness);
    queries.push(appendHardTemporalScope(q.join(" "), temporalConstraint));
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
        queries.push(appendHardTemporalScope(q.join(" "), temporalConstraint));
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
    queries.push(appendHardTemporalScope(q.join(" "), temporalConstraint));
  }

  return queries.slice(0, maxQueries);
}

/**
 * Generate one bounded retry query for unconstrained queries with zero trusted evidence.
 * Derives a compact query from the original goal — no LLM rewrite.
 */
function generateZeroEvidenceFallbackQuery(
  originalGoal: string,
  temporalConstraint: ReturnType<typeof extractQueryRequirements>["temporalConstraint"],
): string {
  const freshness = extractFreshnessSignals(originalGoal);
  // Extract the most meaningful words from the goal
  const words = originalGoal
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  const q = [...words];
  if (freshness) q.push(freshness);
  return appendHardTemporalScope(q.join(" "), temporalConstraint);
}

// ─── Topic Detection for Tavily ────────────────────────────

/**
 * Determine topic category for Tavily retry queries.
 * Reuses deterministic detectTopics() — no LLM involved.
 */
function detectRetryTopicCategory(
  targetedQuery: string,
  entityTerms: string[],
): { category: string; subcategory?: string } {
  try {
    // detectTopics is imported dynamically to avoid circular deps
    const { detectTopics } = require("../rsshub/topic-routes") as typeof import("../rsshub/topic-routes");
    const topics = detectTopics(targetedQuery, entityTerms);
    if (topics.length > 0) {
      return { category: topics[0].category, subcategory: topics[0].subcategory };
    }
  } catch {
    // Topic detection unavailable — fall through to general
  }
  return { category: "general" };
}

// ─── Tavily Retry Provider ─────────────────────────────────

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

/** Structured result distinguishing provider availability from results */
type TavilyRetryResult = {
  candidates: TavilyRetryCandidate[];
  providerAvailable: boolean;
  hadSuccessfulSearch: boolean;
};

/**
 * Fetch targeted Tavily candidates for a retry round.
 * Returns structured result with provider availability distinction.
 * Uses targeted entityTerms from query itself.
 * Propagates delegated routeTier.
 * Uses detected topicCategory.
 */
async function fetchRetryTavilyCandidates(
  queries: string[],
  retrievalContext: RetrievalContext,
  callerTag: string,
  delegatedRouteTier: string,
): Promise<TavilyRetryResult> {
  const empty: TavilyRetryResult = {
    candidates: [],
    providerAvailable: false,
    hadSuccessfulSearch: false,
  };

  try {
    const { isTavilyEnabled, fetchTavilyLiveSources } = await import(
      "../web-search/tavily-live-search"
    );
    if (!isTavilyEnabled()) return { ...empty, providerAvailable: false };

    const allCandidates: TavilyRetryCandidate[] = [];
    let hadSuccessfulSearch = false;

    for (const query of queries) {
      try {
        // Build targeted entityTerms from the query itself
        // Do NOT prepend generic retrievalContext.entityTerms — that defeats targeting
        const queryTerms = query
          .split(/\s+/)
          .filter((t) => t.length > 2);

        // Detect topic category from the targeted query
        const { category, subcategory } = detectRetryTopicCategory(
          query,
          queryTerms,
        );

        // Propagate external delegated tier
        // Do NOT pass internal tier values to Tavily
        const isExternalAdvanced = delegatedRouteTier === "advanced";

        const result = await fetchTavilyLiveSources({
          userGoal: query,
          entityTerms: queryTerms,
          topicCategory: category,
          topicSubcategory: subcategory,
          callerTag,
          routeTier: isExternalAdvanced ? "advanced" : delegatedRouteTier,
        });

        // A search is "successful" when Tavily returned a usable response.
        // error_class null or all_results_filtered = search completed (may have zero results).
        // tavily_disabled, empty_query, thrown errors = NOT successful.
        if (
          result.error_class === "tavily_disabled" ||
          result.error_class === "empty_query"
        ) {
          continue;
        }
        // Any other error_class (e.g. network/timeout/API failure from the catch above)
        // also means the search did not complete successfully.
        if (result.error_class !== null && result.error_class !== "all_results_filtered") {
          continue;
        }

        hadSuccessfulSearch = true;

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

    return {
      candidates: allCandidates,
      providerAvailable: true,
      hadSuccessfulSearch,
    };
  } catch {
    // Tavily unavailable
    return { ...empty, providerAvailable: false };
  }
}

/**
 * Dedupe candidates by canonical URL against already-processed URLs.
 * Uses canonicalizeUrl for proper tracking-param/fragment stripping.
 */
function dedupeCandidates(
  candidates: TavilyRetryCandidate[],
  existingUrls: Set<string>,
): TavilyRetryCandidate[] {
  const seen = new Set(existingUrls);
  const deduped: TavilyRetryCandidate[] = [];

  for (const c of candidates) {
    const url = canonicalizeUrl(c.source_url || "");
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
 * Then bounded retry rounds (max 2) for missing coverage using targeted Tavily queries.
 * Zero-evidence unconstrained queries use a fallback query within the same retry loop.
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
        temporalCoverageOk: false,
        inWindowTrustedEvidenceCount: 0,
        temporalEligibleTrustedEvidenceCount: 0,
        temporalConstraint: null,
        requirementsValid: false,
        requirementsWarnings: ["no_retrieval_context"],
        trustedEvidenceCount: 0,
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

  // ── Hard-enforce source cap from initial input (item 5) ──
  // Canonical-dedupe initial sources first, then limit to maxTotalSources
  const seenCanonicalUrls = new Set<string>();
  const dedupedInitialSources: SourceItem[] = [];
  for (const s of initialSources) {
    const canon = canonicalizeUrl(s.url || "");
    if (!canon || seenCanonicalUrls.has(canon)) continue;
    seenCanonicalUrls.add(canon);
    if (dedupedInitialSources.length >= RETRIEVAL_CONFIG.maxTotalSources) break;
    dedupedInitialSources.push(s);
  }

  const allGradedChunks: GradedEvidenceChunk[] = [];
  const allResolvedSources: SourceItem[] = [...dedupedInitialSources];

  // Use canonical URL for processedUrls tracking
  const processedUrls = new Set(
    dedupedInitialSources.map((s) => canonicalizeUrl(s.url || "")),
  );

  const retryRounds: EvidenceRetryRound[] = [];
  const retryQueries: string[] = [];
  let stoppedReason: EvidenceRetrievalResult["stoppedReason"] = "deadline";

  // ── First pass: initial sources → documents → chunks → rank → grade ──
  if (Date.now() < deadline) {
    try {
      const documents = await buildEvidenceDocuments(dedupedInitialSources);
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
      } else {
        const chunks = await chunkEvidenceDocuments(documents);
        if (Date.now() >= deadline) {
          stoppedReason = "deadline";
        } else {
          const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);
          if (Date.now() >= deadline) {
            stoppedReason = "deadline";
          } else {
            const gradingResult = await gradeEvidenceChunks({
              retrievalContext,
              rankedChunks,
              routeTier: internalRouteTier,
            });
            allGradedChunks.push(...gradingResult.chunks);
          }
        }
      }
    } catch (err: unknown) {
      console.error("[evidence-retrieval] first pass failed", {
        error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150),
      });
    }
  }

  // ── Compute initial coverage ──
  let coverage = computeEvidenceCoverage(allGradedChunks, retrievalContext);

  if (isCoverageComplete(coverage, retrievalContext)) {
    // Enforce final chunk cap
    const finalChunks = allGradedChunks.slice(0, RETRIEVAL_CONFIG.maxTotalGradedChunks);
    return {
      gradedChunks: finalChunks,
      resolvedSources: allResolvedSources,
      coverage,
      retryRounds,
      retryQueries,
      stoppedReason: "coverage_complete",
    };
  }

  // ── Unified retry loop (max 2 rounds, includes zero-evidence fallback) ──
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

    // Generate queries: zero-evidence fallback OR targeted retry
    const isZeroEvidenceUnconstrained =
      coverage.trustedEvidenceCount === 0 &&
      coverage.requiredEntities.length === 0 &&
      coverage.requiredAspects.length === 0;

    const canonicalRequirements = retrievalContext.queryRequirements
      ?? extractQueryRequirements(retrievalContext.originalGoal);
    let queries: string[];
    if (isZeroEvidenceUnconstrained) {
      // Zero trusted evidence + no constraints → one originalGoal-derived fallback query
      queries = [generateZeroEvidenceFallbackQuery(
        retrievalContext.originalGoal,
        canonicalRequirements.temporalConstraint,
      )];
    } else {
      queries = generateTargetedRetryQueries(
        coverage,
        retrievalContext.originalGoal,
        canonicalRequirements.temporalConstraint,
        RETRIEVAL_CONFIG.maxQueriesPerRound,
      );
    }

    retryQueries.push(...queries);

    if (queries.length === 0) {
      stoppedReason = "coverage_complete";
      break;
    }

    const coverageBefore = { ...coverage };

    // Deadline check before Tavily request
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Fetch Tavily candidates
    const retryResult = await fetchRetryTavilyCandidates(
      queries,
      retrievalContext,
      `evidence_retry_round_${round}`,
      delegatedRouteTier,
    );

    // Distinguish provider unavailable from no results.
    // provider_unavailable: Tavily disabled, or every query failed before a usable response.
    // no_new_sources: at least one search completed but yielded zero usable new sources.
    if (!retryResult.providerAvailable || !retryResult.hadSuccessfulSearch) {
      stoppedReason = "provider_unavailable";
      break;
    }
    if (retryResult.candidates.length === 0) {
      stoppedReason = "no_new_sources";
      break;
    }

    // Deadline check before dedupe
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Dedupe against existing sources using canonical URLs
    const newCandidates = dedupeCandidates(retryResult.candidates, processedUrls);

    if (newCandidates.length === 0) {
      // All candidates were duplicates of already-processed sources
      stoppedReason = "no_new_sources";
      break;
    }

    // Deadline check before resolver
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Pass through canonical resolver
    let newSources: SourceItem[] = [];
    try {
      const { resolveSources } = await import("../sources/source-resolver");

      // Enforce source budget
      const remainingSourceBudget = RETRIEVAL_CONFIG.maxTotalSources - allResolvedSources.length;
      if (remainingSourceBudget <= 0) {
        stoppedReason = "retry_limit";
        break;
      }

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
        requestedAspects: canonicalRequirements.requestedAspects.map((aspect) => aspect.key),
        maxSources: Math.min(remainingSourceBudget, 5),
      });

      if (resolverResult.ok && resolverResult.sourceContext.source_count > 0) {
        newSources = resolverResult.sourceContext.sources_used;
      }
    } catch {
      // Resolver failed — continue with what we have
    }

    // Track new URLs with canonical form
    for (const s of newSources) {
      const url = canonicalizeUrl(s.url || "");
      if (url) processedUrls.add(url);
    }

    // Deadline check before content fetch
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Content fetch → chunk → rank → grade new sources
    let newGradedChunks: GradedEvidenceChunk[] = [];
    try {
      const documents = await buildEvidenceDocuments(newSources);
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
        break;
      }
      const chunks = await chunkEvidenceDocuments(documents);
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
        break;
      }
      const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
        break;
      }

      const gradingResult = await gradeEvidenceChunks({
        retrievalContext,
        rankedChunks,
        routeTier: internalRouteTier,
      });

      newGradedChunks = gradingResult.chunks;
    } catch {
      // Fetch/chunk/rank/grade failed for this round — continue
    }

    // Enforce chunk cap before merging
    const remainingChunkBudget = RETRIEVAL_CONFIG.maxTotalGradedChunks - allGradedChunks.length;
    if (remainingChunkBudget <= 0) {
      stoppedReason = "retry_limit";
      break;
    }
    // Retain highest-quality chunks if truncation needed
    const chunksToAdd = newGradedChunks.length > remainingChunkBudget
      ? newGradedChunks
          .sort((a, b) => b.grade.supportStrength - a.grade.supportStrength)
          .slice(0, remainingChunkBudget)
      : newGradedChunks;

    allGradedChunks.push(...chunksToAdd);
    allResolvedSources.push(...newSources);

    // Recompute coverage
    coverage = computeEvidenceCoverage(allGradedChunks, retrievalContext);

    // Compute newSourceCount using canonical URLs
    const initialCanonicalSet = new Set(
      dedupedInitialSources.map((s) => canonicalizeUrl(s.url || "")),
    );
    const newCanonicalSources = newSources.filter(
      (s) => !initialCanonicalSet.has(canonicalizeUrl(s.url || "")),
    );

    retryRounds.push({
      round,
      queries,
      candidateCount: retryResult.candidates.length,
      resolvedSourceCount: newSources.length,
      newSourceCount: newCanonicalSources.length,
      coverageBefore,
      coverageAfter: { ...coverage },
    });

    if (isCoverageComplete(coverage, retrievalContext)) {
      stoppedReason = "coverage_complete";
      break;
    }
  }

  // Final hard cap enforcement on output
  const finalGradedChunks = allGradedChunks.slice(0, RETRIEVAL_CONFIG.maxTotalGradedChunks);
  const finalResolvedSources = allResolvedSources.slice(0, RETRIEVAL_CONFIG.maxTotalSources);

  return {
    gradedChunks: finalGradedChunks,
    resolvedSources: finalResolvedSources,
    coverage,
    retryRounds,
    retryQueries,
    stoppedReason,
  };
}
