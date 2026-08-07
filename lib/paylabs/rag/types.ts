/**
 * RAG Evidence Types
 *
 * Internal types for bounded evidence retrieval and grounding.
 * These are NOT new agents or services — internal helpers only.
 */

/** Evidence granularity levels */
export type EvidenceGranularity = "content" | "snippet" | "metadata_only";

/**
 * A single evidence document retrieved from a source URL.
 * Contains bounded readable content extracted from the source.
 */
export type EvidenceDocument = {
  /** Source identifier (feed_item_id or generated id) */
  sourceId: string;
  /** Original URL from the source */
  url: string;
  /** Canonical URL after redirect resolution */
  canonicalUrl: string;
  /** Document title */
  title: string;
  /** Domain hostname */
  domain: string | null;
  /** Publication date if available */
  publishedAt: string | null;
  /** When this evidence was retrieved */
  retrievedAt: string;
  /** Bounded readable text content */
  text: string;
  /** Granularity of the evidence */
  evidenceGranularity: EvidenceGranularity;
};

/**
 * Fetch options for bounded document retrieval.
 */
export type ContentFetchOptions = {
  /** Maximum response body bytes (default 200KB) */
  maxBytes?: number;
  /** Maximum fetch timeout in ms (default 10s) */
  timeoutMs?: number;
  /** Maximum redirect hops (default 3) */
  maxRedirects?: number;
};

/**
 * A bounded chunk of evidence text with provenance metadata.
 */
export type EvidenceChunk = {
  /** Unique chunk identifier */
  id: string;
  /** Source document identifier */
  sourceId: string;
  /** Chunk text content */
  text: string;
  /** Provenance and metadata */
  metadata: {
    url: string;
    canonicalUrl: string;
    title: string;
    domain: string | null;
    publishedAt: string | null;
    chunkIndex: number;
    evidenceGranularity: EvidenceGranularity;
    /** Entities this chunk provides support for */
    entitySupport: string[];
    /** Aspects this chunk provides support for */
    aspectSupport: string[];
  };
};


// ─── Chunk Relevance ───────────────────────────────────────

/**
 * Relevance result for a single evidence chunk.
 * Combines deterministic lexical signals with optional semantic similarity.
 */
export type ChunkRelevance = {
  /** Unique chunk identifier */
  chunkId: string;
  /** Final composed score (0..1, higher = more relevant) */
  score: number;

  /** Canonical entity names this chunk supports */
  entitySupport: string[];
  /** Requested aspects this chunk covers */
  aspectSupport: string[];
  /** Locked phrases matched in this chunk */
  lockedPhraseSupport: string[];

  /** Deterministic lexical score component (0..1) */
  lexicalScore: number;
  /** Semantic similarity score (0..1) or null if unavailable */
  semanticScore: number | null;
  /** Source quality score (0..1) */
  qualityScore: number;

  /** If rejected, the reason; null if accepted */
  rejectionReason: string | null;
};

/**
 * An evidence chunk paired with its relevance ranking.
 */
export type RankedEvidenceChunk = {
  chunk: EvidenceChunk;
  relevance: ChunkRelevance;
};


// ─── Evidence Grading ──────────────────────────────────────

/**
 * LLM-verified relevance grade for a single evidence chunk.
 * The grader may reduce or remove support but NEVER invent new support.
 */
export type EvidenceGrade = {
  /** Whether the chunk substantively helps answer the query */
  relevant: boolean;
  /** Entity support — intersectioned with deterministic entitySupport */
  entitySupport: string[];
  /** Aspect support — intersectioned with deterministic aspectSupport */
  aspectSupport: string[];
  /** Normalized support strength (0..1) */
  supportStrength: number;
  /** If rejected, the specific reason */
  rejectionReason:
    | "does_not_answer_query"
    | "entity_only_no_requested_aspect"
    | "weak_or_indirect_support"
    | "metadata_only"
    | "duplicate_or_redundant"
    | "insufficient_content"
    | null;
  /** How this grade was produced */
  gradingMode: "llm" | "deterministic_reject" | "deterministic_fallback";
};

/**
 * An evidence chunk with both relevance ranking and LLM grading.
 */
export type GradedEvidenceChunk = {
  chunk: EvidenceChunk;
  relevance: ChunkRelevance;
  grade: EvidenceGrade;
};

/**
 * Result of the evidence grading pipeline.
 */
export type EvidenceGradingResult = {
  /** All chunks with grades applied */
  chunks: GradedEvidenceChunk[];
  /** Number of LLM calls made */
  llmCalls: number;
  /** Whether LLM was available */
  llmAvailable: boolean;
  /** Number of chunks graded by LLM */
  gradedCount: number;
  /** Number of chunks deterministically rejected */
  deterministicRejectCount: number;
};

// ─── Evidence Coverage ────────────────────────────────────

/**
 * Evidence coverage across graded chunks.
 * Computed ONLY from trusted grade-level support (not raw relevance).
 */
export type EvidenceCoverage = {
  /** Required primary entities from retrievalContext */
  requiredEntities: string[];
  /** Entities covered by trusted graded evidence */
  coveredEntities: string[];
  /** Required entities with no trusted coverage */
  missingEntities: string[];

  /** Required aspects from retrievalContext */
  requiredAspects: string[];
  /** Aspects covered by trusted graded evidence */
  coveredAspects: string[];
  /** Required aspects with no trusted coverage */
  missingAspects: string[];

  /** Whether this is a comparison-style query */
  comparisonLike: boolean;

  /** Per-entity × aspect coverage matrix (only when comparisonLike=true) */
  entityAspectCoverage: Array<{
    entity: string;
    coveredAspects: string[];
    missingAspects: string[];
  }>;
};

/**
 * One bounded retry round for missing evidence coverage.
 */
export type EvidenceRetryRound = {
  /** Round number (1-indexed) */
  round: number;
  /** Targeted queries generated for this round */
  queries: string[];
  /** Raw Tavily candidates returned */
  candidateCount: number;
  /** Candidates that passed canonical resolver */
  resolvedSourceCount: number;
  /** Sources that were NEW (not in previous rounds) */
  newSourceCount: number;
  /** Coverage snapshot before this round */
  coverageBefore: EvidenceCoverage;
  /** Coverage snapshot after this round */
  coverageAfter: EvidenceCoverage;
};

/**
 * Complete result of the bounded evidence retrieval pipeline.
 * Internal runtime structure — not persisted or exposed publicly.
 */
export type EvidenceRetrievalResult = {
  /** All graded chunks across all rounds */
  gradedChunks: GradedEvidenceChunk[];
  /** All resolver-approved sources across all rounds */
  resolvedSources: import("../sources/types").SourceItem[];
  /** Final coverage snapshot */
  coverage: EvidenceCoverage;
  /** Retry rounds executed */
  retryRounds: EvidenceRetryRound[];
  /** Targeted queries that were generated */
  retryQueries: string[];
  /** Why the pipeline stopped */
  stoppedReason:
    | "coverage_complete"
    | "retry_limit"
    | "no_new_sources"
    | "provider_unavailable"
    | "deadline"
    | "no_retrieval_context";
};

/** Default configuration constants */
export const CONTENT_FETCH_DEFAULTS = {
  maxBytes: 200_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
} as const;
