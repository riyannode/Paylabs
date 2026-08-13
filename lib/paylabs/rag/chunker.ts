/**
 * Evidence Chunker
 *
 * Converts EvidenceDocuments into bounded EvidenceChunks using
 * LangChain's RecursiveCharacterTextSplitter for provenance-preserving
 * chunking with bounded sizing.
 *
 * This is NOT a new agent. Internal helper for the grounding pipeline.
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EvidenceDocument, EvidenceChunk } from "./types";

// ─── Hard Caps ─────────────────────────────────────────────

const CHUNKING_CONFIG = {
  /** Target chunk size in characters (~600-1200 tokens) */
  chunkSize: 3000,
  /** Overlap between chunks in characters */
  chunkOverlap: 300,
  /** Maximum source documents per run */
  maxSourceDocuments: 10,
  /** Maximum characters per source document */
  maxCharsPerSource: 50_000,
  /** Maximum chunks per source document */
  maxChunksPerSource: 15,
  /** Total maximum chunks per run */
  totalMaxChunks: 80,
};

// ─── Chunker ───────────────────────────────────────────────

/**
 * Split an evidence document into bounded chunks.
 * Returns at most maxChunksPerSource chunks.
 */
async function chunkDocument(doc: EvidenceDocument): Promise<EvidenceChunk[]> {
  // Truncate to max chars per source
  const text = doc.text.slice(0, CHUNKING_CONFIG.maxCharsPerSource);

  if (text.length < 50) {
    // Too short to chunk — return as single metadata_only chunk
    return [{
      id: `${doc.sourceId}-c0`,
      sourceId: doc.sourceId,
      text,
      metadata: {
        url: doc.url,
        canonicalUrl: doc.canonicalUrl,
        title: doc.title,
        domain: doc.domain,
        publishedAt: doc.publishedAt,
        chunkIndex: 0,
        evidenceGranularity: doc.evidenceGranularity,
        entitySupport: [],
        aspectSupport: [],
      },
    }];
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNKING_CONFIG.chunkSize,
    chunkOverlap: CHUNKING_CONFIG.chunkOverlap,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const splits = await splitter.createDocuments([text]);

  return splits.slice(0, CHUNKING_CONFIG.maxChunksPerSource).map((split, index) => ({
    id: `${doc.sourceId}-c${index}`,
    sourceId: doc.sourceId,
    text: split.pageContent,
    metadata: {
      url: doc.url,
      canonicalUrl: doc.canonicalUrl,
      title: doc.title,
      domain: doc.domain,
      publishedAt: doc.publishedAt,
      chunkIndex: index,
      evidenceGranularity: doc.evidenceGranularity,
      entitySupport: [],
      aspectSupport: [],
    },
  }));
}

/**
 * Chunk multiple evidence documents into bounded evidence chunks.
 * Applies global caps: maxSourceDocuments, totalMaxChunks.
 */
export async function chunkEvidenceDocuments(
  documents: EvidenceDocument[],
): Promise<EvidenceChunk[]> {
  const allChunks: EvidenceChunk[] = [];
  const docsToChunk = documents.slice(0, CHUNKING_CONFIG.maxSourceDocuments);

  for (const doc of docsToChunk) {
    if (allChunks.length >= CHUNKING_CONFIG.totalMaxChunks) break;

    const chunks = await chunkDocument(doc);
    const remaining = CHUNKING_CONFIG.totalMaxChunks - allChunks.length;
    allChunks.push(...chunks.slice(0, remaining));
  }

  return allChunks;
}
