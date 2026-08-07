/**
 * Hybrid Evidence Chunk Ranker
 *
 * Ranks evidence chunks using deterministic lexical/entity/aspect signals
 * with optional semantic similarity. This is NOT a new PayLab agent.
 * This creates NO x402/payment edge.
 *
 * Scoring formula (conceptual):
 *   final = entityScore + aspectScore + lockedPhraseScore + lexicalScore
 *         + boundedSemanticScore + qualityScore - penalties
 *
 * Deterministic signals are authoritative. Semantic similarity supplements.
 */

import type { EvidenceChunk, ChunkRelevance, RankedEvidenceChunk } from "./types";
import type { RetrievalContext } from "../sources/types";

// ─── Reuse Existing Canonical Helpers ───────────────────────

// Dynamic import to avoid circular deps; these are stable pure functions
let _matchesExactPhrase: ((text: string, phrase: string) => boolean) | null = null;
let _getMatchedAspectsForText: ((text: string, aspects: string[]) => string[]) | null = null;
let _ASPECT_DEFINITIONS: Record<string, { signalTerms: string[] }> | null = null;

async function getMatchesExactPhrase() {
  if (!_matchesExactPhrase) {
    const mod = await import("../sources/source-relevance");
    _matchesExactPhrase = mod.matchesExactPhrase;
  }
  return _matchesExactPhrase!;
}

async function getMatchedAspectsForText() {
  if (!_getMatchedAspectsForText) {
    const mod = await import("../sources/source-relevance");
    _getMatchedAspectsForText = mod.getMatchedAspectsForText;
  }
  return _getMatchedAspectsForText!;
}

async function getAspectDefinitions() {
  if (!_ASPECT_DEFINITIONS) {
    const mod = await import("../sources/crypto-entity-registry");
    _ASPECT_DEFINITIONS = mod.ASPECT_DEFINITIONS;
  }
  return _ASPECT_DEFINITIONS!;
}

// ─── Score Weights ─────────────────────────────────────────

/**
 * Weighting constants for score composition.
 * All component scores are normalized to 0..1 before weighting.
 * Required entity support and aspect support dominate over semantic similarity.
 */
const WEIGHTS = {
  /** Required primary entity matched (strongest signal) */
  requiredEntity: 0.30,
  /** Requested aspect matched */
  aspect: 0.20,
  /** Locked phrase matched */
  lockedPhrase: 0.10,
  /** Lexical query term overlap */
  lexical: 0.15,
  /** Semantic similarity (supplement only, max 0.4 of its weight) */
  semantic: 0.10,
  /** Source quality (title length, content depth, domain reputation) */
  quality: 0.15,
} as const;

// ─── Granularity Penalty ───────────────────────────────────

const GRANULARITY_PENALTY: Record<string, number> = {
  content: 0,
  snippet: 0.15,
  metadata_only: 0.40,
};

// ─── Penalty Constants ─────────────────────────────────────

const PENALTY = {
  /** No required entity match when required entities exist */
  noRequiredEntity: 0.50,
  /** Entity-only match with no requested aspect (for technical intents) */
  entityOnlyNoAspect: 0.35,
  /** Very short chunk (< 100 chars) */
  shortChunk: 0.10,
  /** Generic boilerplate detected */
  genericBoilerplate: 0.10,
} as const;

// ─── Domain Quality Heuristic ──────────────────────────────

const HIGH_QUALITY_DOMAINS = new Set([
  "docs", "github.com", "ethereum.org", "solana.com",
  "circle.com", "docs.chain.link", "docs.openzeppelin.org",
  "developer.mozilla.org", "arxiv.org", "iacr.org",
]);

function computeQualityScore(chunk: EvidenceChunk): number {
  let score = 0.5; // baseline

  // Title length: substantive titles are better
  const titleLen = (chunk.metadata.title || "").length;
  if (titleLen > 40) score += 0.15;
  if (titleLen > 80) score += 0.10;

  // Content depth: longer text = more substance
  const textLen = chunk.text.length;
  if (textLen > 200) score += 0.10;
  if (textLen > 500) score += 0.10;
  if (textLen > 1500) score += 0.05;

  // Domain quality
  const domain = (chunk.metadata.domain || "").toLowerCase();
  if (HIGH_QUALITY_DOMAINS.has(domain) || domain.startsWith("docs.")) {
    score += 0.15;
  }

  // Published date recency (if available)
  if (chunk.metadata.publishedAt) {
    const age = Date.now() - new Date(chunk.metadata.publishedAt).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (days < 30) score += 0.10;
    else if (days < 90) score += 0.05;
  }

  return Math.min(score, 1.0);
}

// ─── Generic Boilerplate Detection ─────────────────────────

const BOILERPLATE_PATTERNS = [
  /\b(breaking news|market update|today'?s market|crypto market today)\b/i,
  /\b(in the news|trending now|hot topic|viral)\b/i,
  /\b(price prediction|price forecast|market cap|all[- ]?time high)\b/i,
  /\b(whale alert|whale moves|large transfer)\b/i,
  /\b(fear and greed|bull bear|altcoin season)\b/i,
];

function isGenericBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((p) => p.test(text));
}

// ─── Lexical Query Overlap ─────────────────────────────────

function computeLexicalOverlap(
  chunkText: string,
  normalizedGoal: string,
  entityTerms: string[],
): number {
  const textLower = chunkText.toLowerCase();
  const goalWords = normalizedGoal
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (goalWords.length === 0) return 0;

  let matched = 0;
  for (const word of goalWords) {
    if (textLower.includes(word)) matched++;
  }

  // Also check entity terms
  for (const term of entityTerms) {
    if (textLower.includes(term.toLowerCase())) matched++;
  }

  // Normalize: cap at 1.0
  return Math.min(matched / Math.max(goalWords.length, 1), 1.0);
}

// ─── Semantic Similarity (Optional) ────────────────────────

/**
 * Compute semantic similarity using OpenAI embeddings.
 * Ephemeral per-run only. No vectors persisted.
 * Returns null if embeddings unavailable or fail.
 */
async function computeSemanticSimilarity(
  queryText: string,
  chunkTexts: string[],
): Promise<(number | null)[]> {
  try {
    const { OpenAIEmbeddings } = await import("@langchain/openai");

    // Resolve API key from existing config
    const apiKey =
      process.env.PAYLABS_LLM_API_KEY_DEFAULT ||
      process.env.PAYLABS_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      // No API key — degrade gracefully
      return chunkTexts.map(() => null);
    }

    const embeddings = new OpenAIEmbeddings({
      modelName: "text-embedding-3-small",
      apiKey,
      // Use existing base URL if configured (for proxies)
      ...(process.env.PAYLABS_LLM_BASE_URL ? { baseUrl: process.env.PAYLABS_LLM_BASE_URL } : {}),
    });

    // Embed query + all chunks in one batch
    const allTexts = [queryText, ...chunkTexts];
    const vectors = await embeddings.embedDocuments(allTexts);

    if (vectors.length !== allTexts.length) {
      return chunkTexts.map(() => null);
    }

    const queryVector = vectors[0];
    const chunkVectors = vectors.slice(1);

    return chunkVectors.map((cv) => cosineSimilarity(queryVector, cv));
  } catch {
    // Embedding failed — degrade gracefully
    return chunkTexts.map(() => null);
  }
}

/** Compute cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Main Ranking Function ─────────────────────────────────

/**
 * Rank evidence chunks using hybrid lexical + semantic relevance.
 *
 * Input: RetrievalContext + EvidenceChunk[]
 * Output: RankedEvidenceChunk[] (sorted by score descending)
 *
 * Deterministic signals are authoritative.
 * Semantic similarity supplements but never creates entity/aspect support.
 */
export async function rankEvidenceChunks(
  retrievalContext: RetrievalContext,
  chunks: EvidenceChunk[],
  options?: { enableSemantic?: boolean; maxSemanticChunks?: number },
): Promise<RankedEvidenceChunk[]> {
  const enableSemantic = options?.enableSemantic !== false;
  const maxSemanticChunks = options?.maxSemanticChunks ?? 35;

  const matchesExactPhrase = await getMatchesExactPhrase();
  const getMatchedAspects = await getMatchedAspectsForText();

  // Build query text for lexical and semantic matching
  const queryText = retrievalContext.originalGoal;
  const normalizedGoal = retrievalContext.normalizedGoal;
  const requiredEntities = retrievalContext.primaryEntities.filter((e) => e.required);
  const requestedAspects = retrievalContext.requestedAspects;
  const lockedPhrases = retrievalContext.lockedPhrases;
  const entityTerms = retrievalContext.entityTerms;

  // ── Phase 1: Deterministic support extraction ──
  const relevances: ChunkRelevance[] = chunks.map((chunk) => {
    const text = `${chunk.metadata.title} ${chunk.text}`;
    const textLower = text.toLowerCase();

    // Entity support (boundary-aware, from canonical matching)
    const entitySupport: string[] = [];
    for (const entity of retrievalContext.primaryEntities) {
      if (matchesExactPhrase(text, entity.canonical) || matchesExactPhrase(text, entity.text)) {
        entitySupport.push(entity.canonical);
      }
    }
    // Secondary entities
    const secondaryEntitySupport: string[] = [];
    for (const entity of retrievalContext.secondaryEntities) {
      if (matchesExactPhrase(text, entity.canonical) || matchesExactPhrase(text, entity.text)) {
        secondaryEntitySupport.push(entity.canonical);
      }
    }

    // Aspect support (uses ASPECT_DEFINITIONS signal terms)
    const aspectSupport = getMatchedAspects(text, requestedAspects);

    // Locked phrase support
    const lockedPhraseSupport = lockedPhrases.filter(
      (phrase) => matchesExactPhrase(text, phrase),
    );

    // ── Reject: no required entity when required entities exist ──
    const hasRequiredEntity = requiredEntities.length === 0 ||
      requiredEntities.some((e) => entitySupport.includes(e.canonical));

    let rejectionReason: string | null = null;
    if (requiredEntities.length > 0 && !hasRequiredEntity) {
      rejectionReason = "missing_required_entity";
    }

    // ── Compute component scores ──

    // Required entity score (0..1)
    const requiredEntityScore = requiredEntities.length === 0
      ? 1.0 // no required entities → neutral
      : hasRequiredEntity
        ? entitySupport.filter((e) => requiredEntities.some((re) => re.canonical === e)).length / requiredEntities.length
        : 0;

    // Aspect score (0..1)
    const aspectScore = requestedAspects.length === 0
      ? 1.0
      : aspectSupport.length / requestedAspects.length;

    // Locked phrase score (0..1)
    const lockedPhraseScore = lockedPhrases.length === 0
      ? 1.0
      : lockedPhraseSupport.length / lockedPhrases.length;

    // Lexical overlap (0..1)
    const lexicalScore = computeLexicalOverlap(text, normalizedGoal, entityTerms);

    // Quality score (0..1)
    const qualityScore = computeQualityScore(chunk);

    // ── Penalties ──
    let penalty = 0;

    // No required entity match
    if (requiredEntities.length > 0 && !hasRequiredEntity) {
      penalty += PENALTY.noRequiredEntity;
    }

    // Entity-only with no aspect (for technical/comparison intents)
    if (entitySupport.length > 0 && aspectSupport.length === 0 && requestedAspects.length > 0) {
      penalty += PENALTY.entityOnlyNoAspect;
    }

    // Short chunk
    if (chunk.text.length < 100) {
      penalty += PENALTY.shortChunk;
    }

    // Generic boilerplate
    if (isGenericBoilerplate(text)) {
      penalty += PENALTY.genericBoilerplate;
    }

    // Granularity penalty
    penalty += GRANULARITY_PENALTY[chunk.metadata.evidenceGranularity] || 0;

    // ── Compose final score ──
    const finalScore = Math.max(0, Math.min(1,
      WEIGHTS.requiredEntity * requiredEntityScore +
      WEIGHTS.aspect * aspectScore +
      WEIGHTS.lockedPhrase * lockedPhraseScore +
      WEIGHTS.lexical * lexicalScore +
      WEIGHTS.quality * qualityScore -
      penalty
    ));

    return {
      chunkId: chunk.id,
      score: finalScore,
      entitySupport,
      aspectSupport,
      lockedPhraseSupport,
      lexicalScore,
      semanticScore: null, // filled in Phase 2
      qualityScore,
      rejectionReason,
    };
  });

  // ── Phase 2: Optional semantic similarity ──
  if (enableSemantic) {
    // Only embed chunks that passed lexical prefilter (score > 0.1)
    const embeddable = relevances
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.score > 0.1 && !r.rejectionReason)
      .slice(0, maxSemanticChunks);

    if (embeddable.length > 0) {
      const chunkTexts = embeddable.map(({ i }) =>
        `${chunks[i].metadata.title} ${chunks[i].text.slice(0, 2000)}`
      );
      const semanticScores = await computeSemanticSimilarity(queryText, chunkTexts);

      for (let j = 0; j < embeddable.length; j++) {
        const semScore = semanticScores[j];
        if (semScore !== null) {
          const idx = embeddable[j].i;
          // Bounded: semantic contributes at most 0.4 of its weight
          const boundedSemantic = Math.max(0, Math.min(1, semScore)) * 0.4;
          relevances[idx].semanticScore = semScore;
          relevances[idx].score = Math.max(0, Math.min(1,
            relevances[idx].score + WEIGHTS.semantic * boundedSemantic
          ));
        }
      }
    }
  }

  // ── Phase 3: Build RankedEvidenceChunk output ──
  const ranked: RankedEvidenceChunk[] = chunks.map((chunk, i) => ({
    chunk,
    relevance: relevances[i],
  }));

  // Sort by score descending
  ranked.sort((a, b) => b.relevance.score - a.relevance.score);

  // Populate chunk metadata support fields
  for (const item of ranked) {
    item.chunk.metadata.entitySupport = item.relevance.entitySupport;
    item.chunk.metadata.aspectSupport = item.relevance.aspectSupport;
  }

  return ranked;
}
