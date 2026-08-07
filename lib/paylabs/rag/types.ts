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

/** Default configuration constants */
export const CONTENT_FETCH_DEFAULTS = {
  maxBytes: 200_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
} as const;
