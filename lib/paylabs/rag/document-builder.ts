/**
 * Evidence Document Builder
 *
 * Converts resolved source items into bounded EvidenceDocuments
 * by fetching actual content from source URLs.
 *
 * This is NOT a new agent. It's an internal helper used by the
 * grounding pipeline to enrich source metadata with actual content.
 */

import type { SourceItem } from "../sources/types";
import type { EvidenceDocument, ContentFetchOptions } from "./types";
import { fetchBoundedContent } from "./content-fetcher";

/** Maximum concurrent fetches */
const MAX_CONCURRENT_FETCHES = 3;

/** Timeout per individual fetch */
const FETCH_TIMEOUT_MS = 8_000;

/** Maximum content bytes per source */
const MAX_CONTENT_BYTES = 150_000;

/**
 * Build EvidenceDocuments from resolved source items.
 *
 * For each source:
 * 1. Fetch bounded readable content from the URL
 * 2. If content is available → granularity "content"
 * 3. If only provider snippet available → granularity "snippet"
 * 4. If no usable text → granularity "metadata_only"
 */
export async function buildEvidenceDocuments(
  sources: SourceItem[],
  options?: ContentFetchOptions,
): Promise<EvidenceDocument[]> {
  const fetchOpts: ContentFetchOptions = {
    maxBytes: MAX_CONTENT_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: 3,
    ...options,
  };

  const documents: EvidenceDocument[] = [];
  const now = new Date().toISOString();

  // Process in bounded batches
  for (let i = 0; i < sources.length; i += MAX_CONCURRENT_FETCHES) {
    const batch = sources.slice(i, i + MAX_CONCURRENT_FETCHES);
    const results = await Promise.allSettled(
      batch.map(async (source) => {
        const url = source.url;
        if (!url || !/^https?:\/\//.test(url)) {
          return buildMetadataOnlyDocument(source, now);
        }

        const fetchResult = await fetchBoundedContent(url, fetchOpts);

        if (fetchResult.ok && fetchResult.text.length >= 50) {
          return {
            sourceId: source.feed_item_id,
            url: source.url,
            canonicalUrl: fetchResult.canonicalUrl || source.url,
            title: source.title || "(untitled)",
            domain: source.domain || extractDomain(fetchResult.canonicalUrl),
            publishedAt: source.published_at || null,
            retrievedAt: now,
            text: fetchResult.text,
            evidenceGranularity: "content" as const,
          };
        }

        // Fallback to snippet from source metadata
        if (source.summary && source.summary.length >= 20) {
          return {
            sourceId: source.feed_item_id,
            url: source.url,
            canonicalUrl: fetchResult.canonicalUrl || source.url,
            title: source.title || "(untitled)",
            domain: source.domain || null,
            publishedAt: source.published_at || null,
            retrievedAt: now,
            text: source.summary,
            evidenceGranularity: "snippet" as const,
          };
        }

        return buildMetadataOnlyDocument(source, now);
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        documents.push(result.value);
      } else {
        // Promise rejection — create metadata_only doc
        // This shouldn't happen since we catch internally, but be safe
        console.warn("[rag] document-build-failure", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  return documents;
}

/** Build a metadata-only evidence document (no fetched content) */
function buildMetadataOnlyDocument(
  source: SourceItem,
  retrievedAt: string,
): EvidenceDocument {
  // Use summary as text if available, otherwise empty
  const text = source.summary || "";

  return {
    sourceId: source.feed_item_id,
    url: source.url,
    canonicalUrl: source.url,
    title: source.title || "(untitled)",
    domain: source.domain || null,
    publishedAt: source.published_at || null,
    retrievedAt,
    text,
    evidenceGranularity: text.length >= 20 ? "snippet" : "metadata_only",
  };
}

/** Extract domain from a URL string */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
