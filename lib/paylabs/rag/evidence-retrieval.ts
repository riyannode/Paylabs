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

  // Count trusted evidence chunks (item 9)
  let trustedEvidenceCount = 0;

  for (const gc of gradedChunks) {
    if (!gc.grade.relevant) continue;
    if (gc.grade.supportStrength < RETRIEVAL_CONFIG.coverageTrustThreshold) continue;

    // This chunk qualifies as trusted evidence
    trustedEvidenceCount++;

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
    trustedEvidenceCount,
  };
}

/**
 * Check if coverage is complete for the given retrieval context.
 * Requires trustedEvidenceCount > 0 — zero trusted evidence means coverage is not complete.
 */
function isCoverageComplete(
  coverage: EvidenceCoverage,
  retrievalContext: RetrievalContext,
): boolean {
  // Zero trusted evidence → coverage not complete (item 9)
  if (coverage.trustedEvidenceCount === 0) return false;

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

/**
 * Generate one bounded retry query for unconstrained queries with zero trusted evidence.
 * Derives a compact query from the original goal — no LLM rewrite.
 */
function generateZeroEvidenceFallbackQuery(originalGoal: string): string {
  const freshness = extractFreshnessSignals(originalGoal);
  // Extract the most meaningful words from the goal
  const words = originalGoal
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  const q = [...words];
  if (freshness) q.push(freshness);
  return q.join(" ");
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
 * Returns structured result with provider availability distinction (item 7).
 * Uses canonicalized URL dedupe (item 2).
 * Uses targeted entityTerms from query itself (item 1).
 * Propagates delegated routeTier (item 5).
 * Uses detected topicCategory (item 6).
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

    // Use canonicalizeUrl for dedupe (item 2)
    const { canonicalizeUrl } = await import("../sources/source-resolver");

    for (const query of queries) {
      try {
        // Build targeted entityTerms from the query itself (item 1)
        // Do NOT prepend generic retrievalContext.entityTerms — that defeats targeting
        const queryTerms = query
          .split(/\s+/)
          .filter((t) => t.length > 2);

        // Detect topic category from the targeted query (item 6)
        const { category, subcategory } = detectRetryTopicCategory(
          query,
          queryTerms,
        );

        // Propagate external delegated tier (item 5)
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

        if (result.error_class === "tavily_disabled") {
          // Provider unavailable
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
 * Uses canonicalizeUrl for proper tracking-param/fragment stripping (item 2).
 */
function dedupeCandidates(
  candidates: TavilyRetryCandidate[],
  existingUrls: Set<string>,
): TavilyRetryCandidate[] {
  const { canonicalizeUrl } = require("../sources/source-resolver") as typeof import("../sources/source-resolver");
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

/**
 * Canonicalize a source URL for tracking.
 */
function canonicalSourceUrl(url: string | undefined): string {
  // Use a simple inline canonicalizer for Set tracking
  // canonicalizeUrl from source-resolver is used for candidate dedupe
  // This is for processedUrls Set which needs a fast inline version
  if (!url) return "";
  try {
    const u = new URL(url);
    const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source", "fbclid", "gclid"]);
    for (const key of TRACKING_PARAMS) {
      u.searchParams.delete(key);
    }
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.hostname.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
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
  const allGradedChunks: GradedEvidenceChunk[] = [];
  const allResolvedSources: SourceItem[] = [...initialSources];

  // Use canonical URL for processedUrls tracking (item 2)
  const processedUrls = new Set(
    initialSources.map((s) => canonicalSourceUrl(s.url)),
  );

  const retryRounds: EvidenceRetryRound[] = [];
  const retryQueries: string[] = [];
  let stoppedReason: EvidenceRetrievalResult["stoppedReason"] = "deadline";

  // ── First pass: initial sources → documents → chunks → rank → grade ──
  // Deadline check before content fetch (item 4)
  if (Date.now() < deadline) {
    try {
      const documents = await buildEvidenceDocuments(initialSources);
      // Deadline check before chunking (item 4)
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
      } else {
        const chunks = await chunkEvidenceDocuments(documents);
        // Deadline check before ranking (item 4)
        if (Date.now() >= deadline) {
          stoppedReason = "deadline";
        } else {
          const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);
          // Deadline check before grading (item 4)
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
    return {
      gradedChunks: allGradedChunks,
      resolvedSources: allResolvedSources,
      coverage,
      retryRounds,
      retryQueries,
      stoppedReason: "coverage_complete",
    };
  }

  // Item 9: For unconstrained queries with zero trusted evidence, generate one bounded retry
  if (
    coverage.trustedEvidenceCount === 0 &&
    coverage.requiredEntities.length === 0 &&
    coverage.requiredAspects.length === 0
  ) {
    const fallbackQuery = generateZeroEvidenceFallbackQuery(retrievalContext.originalGoal);
    retryQueries.push(fallbackQuery);

    // Process this one fallback query as a single round
    const coverageBefore = { ...coverage };
    try {
      const retryResult = await fetchRetryTavilyCandidates(
        [fallbackQuery],
        retrievalContext,
        "evidence_zero_evidence_fallback",
        delegatedRouteTier,
      );

      if (retryResult.providerAvailable && retryResult.hadSuccessfulSearch && retryResult.candidates.length > 0) {
        // Dedupe
        const { canonicalizeUrl } = await import("../sources/source-resolver");
        const seen = new Set(processedUrls);
        const newCandidates: TavilyRetryCandidate[] = [];
        for (const c of retryResult.candidates) {
          const url = canonicalizeUrl(c.source_url || "");
          if (!url || seen.has(url)) continue;
          seen.add(url);
          newCandidates.push(c);
        }

        if (newCandidates.length > 0) {
          // Pass through canonical resolver
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
              3,
            ),
          });

          if (resolverResult.ok && resolverResult.sourceContext.source_count > 0) {
            const newSources = resolverResult.sourceContext.sources_used;

            // Track URLs with canonical form
            for (const s of newSources) {
              const url = canonicalSourceUrl(s.url);
              if (url) processedUrls.add(url);
            }

            // Content fetch → chunk → rank → grade
            if (Date.now() < deadline) {
              try {
                const documents = await buildEvidenceDocuments(newSources);
                if (Date.now() < deadline) {
                  const chunks = await chunkEvidenceDocuments(documents);
                  if (Date.now() < deadline) {
                    const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);
                    if (Date.now() < deadline) {
                      const gradingResult = await gradeEvidenceChunks({
                        retrievalContext,
                        rankedChunks,
                        routeTier: internalRouteTier,
                      });
                      // Enforce chunk cap before merging (item 3)
                      const remainingChunkBudget = RETRIEVAL_CONFIG.maxTotalGradedChunks - allGradedChunks.length;
                      const chunksToAdd = gradingResult.chunks.slice(0, Math.max(0, remainingChunkBudget));
                      allGradedChunks.push(...chunksToAdd);
                      allResolvedSources.push(...newSources);
                    }
                  }
                }
              } catch {
                // Fetch/chunk/rank/grade failed — continue
              }
            }

            coverage = computeEvidenceCoverage(allGradedChunks, retrievalContext);

            retryRounds.push({
              round: 1,
              queries: [fallbackQuery],
              candidateCount: retryResult.candidates.length,
              resolvedSourceCount: newSources.length,
              newSourceCount: newSources.length,
              coverageBefore,
              coverageAfter: { ...coverage },
            });
          }
        }
      }
    } catch {
      // Fallback query failed — continue
    }

    // Re-evaluate after fallback
    if (isCoverageComplete(coverage, retrievalContext)) {
      stoppedReason = "coverage_complete";
      return {
        gradedChunks: allGradedChunks,
        resolvedSources: allResolvedSources,
        coverage,
        retryRounds,
        retryQueries,
        stoppedReason: "coverage_complete",
      };
    }
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

    // Deadline check before Tavily request (item 4)
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Fetch Tavily candidates (item 5: pass delegated tier, item 6: topic detected internally)
    const retryResult = await fetchRetryTavilyCandidates(
      queries,
      retrievalContext,
      `evidence_retry_round_${round}`,
      delegatedRouteTier,
    );

    // Item 7: distinguish provider unavailable from no results
    if (!retryResult.providerAvailable) {
      stoppedReason = "provider_unavailable";
      break;
    }
    if (retryResult.candidates.length === 0) {
      stoppedReason = retryResult.hadSuccessfulSearch ? "no_new_sources" : "no_new_sources";
      break;
    }

    // Deadline check before dedupe (item 4)
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Dedupe against existing sources using canonical URLs (item 2)
    const newCandidates = dedupeCandidates(retryResult.candidates, processedUrls);

    if (newCandidates.length === 0) {
      stoppedReason = "no_new_sources";
      break;
    }

    // Deadline check before resolver (item 4)
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Pass through canonical resolver
    let newSources: SourceItem[] = [];
    try {
      const { resolveSources } = await import("../sources/source-resolver");

      // Enforce source budget (item 3)
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
        requestedAspects: retrievalContext.requestedAspects,
        maxSources: Math.min(remainingSourceBudget, 5),
      });

      if (resolverResult.ok && resolverResult.sourceContext.source_count > 0) {
        newSources = resolverResult.sourceContext.sources_used;
      }
    } catch {
      // Resolver failed — continue with what we have
    }

    // Track new URLs with canonical form (item 2)
    for (const s of newSources) {
      const url = canonicalSourceUrl(s.url);
      if (url) processedUrls.add(url);
    }

    // Deadline check before content fetch (item 4)
    if (Date.now() >= deadline) {
      stoppedReason = "deadline";
      break;
    }

    // Content fetch → chunk → rank → grade new sources
    let newGradedChunks: GradedEvidenceChunk[] = [];
    try {
      const documents = await buildEvidenceDocuments(newSources);
      // Deadline check before chunking (item 4)
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
        break;
      }
      const chunks = await chunkEvidenceDocuments(documents);
      // Deadline check before ranking (item 4)
      if (Date.now() >= deadline) {
        stoppedReason = "deadline";
        break;
      }
      const rankedChunks = await rankEvidenceChunks(retrievalContext, chunks);
      // Deadline check before grading (item 4)
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

    // Enforce chunk cap before merging (item 3)
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

    retryRounds.push({
      round,
      queries,
      candidateCount: retryResult.candidates.length,
      resolvedSourceCount: newSources.length,
      newSourceCount: newSources.filter(
        (s) => !initialSources.some((is) => is.url === s.url),
      ).length,
      coverageBefore,
      coverageAfter: { ...coverage },
    });

    if (isCoverageComplete(coverage, retrievalContext)) {
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
