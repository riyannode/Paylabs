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

/** Default configuration constants */
export const CONTENT_FETCH_DEFAULTS = {
  maxBytes: 200_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
} as const;
