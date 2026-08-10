/**
 * Hybrid Evidence Chunk Ranker
 *
 * Ranks evidence chunks using deterministic lexical/entity/aspect signals
 * with optional semantic similarity. This is NOT a new PayLab agent.
 * This creates NO x402/payment edge.
 *
 * Scoring formula (active-weight normalized):
 *   final = weightedSum / activeWeightSum - penalties, clamped 0..1
 *
 * Deterministic signals are authoritative. Semantic similarity supplements.
 */

import type { EvidenceChunk, ChunkRelevance, RankedEvidenceChunk } from "./types";
import type { RetrievalContext } from "../sources/types";
import {
  getMatchedAspectsForText,
  matchesExactPhrase,
  matchesRequiredEntity,
} from "../sources/source-relevance";
import {
  extractQueryRequirements,
  type QueryRequirements,
} from "../sources/query-requirements";

// ─── Score Weights ─────────────────────────────────────────

/**
 * Weighting constants for active-weight normalization.
 * Only ACTIVE dimensions contribute to the score.
 * Absent constraints are excluded, not rewarded.
 */
const WEIGHTS = {
  /** Required primary entity matched (strongest signal) */
  requiredEntity: 0.30,
  /** Requested aspect matched */
  aspect: 0.20,
  /** Locked phrase matched */
  lockedPhrase: 0.10,
  /** Lexical query term overlap (always active) */
  lexical: 0.15,
  /** Semantic similarity (supplement only, max 0.4 of its weight) */
  semantic: 0.10,
  /** Source quality (always active) */
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

  const titleLen = (chunk.metadata.title || "").length;
  if (titleLen > 40) score += 0.15;
  if (titleLen > 80) score += 0.10;

  const textLen = chunk.text.length;
  if (textLen > 200) score += 0.10;
  if (textLen > 500) score += 0.10;
  if (textLen > 1500) score += 0.05;

  const domain = (chunk.metadata.domain || "").toLowerCase();
  if (HIGH_QUALITY_DOMAINS.has(domain) || domain.startsWith("docs.")) {
    score += 0.15;
  }

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

// ─── Stopwords ─────────────────────────────────────────────

const STOPWORDS = new Set([
  "what", "how", "why", "who", "when", "where",
  "are", "is", "the", "a", "an", "to", "for", "of",
  "and", "or", "in", "on", "with", "from", "by", "at", "it",
  "this", "that", "these", "those", "be", "was", "were", "been",
  "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall",
  "not", "no", "but", "if", "so", "than", "too", "very",
  "just", "about", "into", "over", "after", "before",
  "vs", "versus", "compare", "comparison",
]);

// ─── Lexical Query Overlap (Boundary-Aware) ────────────────

/**
 * Tokenize a string into normalized lowercase tokens, filtering stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Check if a token appears as a whole word in text (boundary-aware).
 * "uni" won't match "university", "sol" won't match "solution".
 */
function hasBoundaryToken(textLower: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,;:!?\\.\\(\\)])${escaped}([\\s,;:!?\\.\\(\\)]|$)`, "i").test(textLower);
}

/**
 * Compute lexical overlap between chunk text and the query.
 * Uses boundary-aware matching to prevent ambiguous short token inflation.
 * Does NOT create entitySupport — that remains deterministic.
 */
function computeLexicalOverlap(
  chunkText: string,
  originalGoal: string,
  normalizedGoal: string,
  entityTerms: string[],
): number {
  const textLower = chunkText.toLowerCase();

  // Tokenize both original and normalized goals, deduplicate
  const goalTokens = [
    ...new Set([
      ...tokenize(originalGoal),
      ...tokenize(normalizedGoal),
    ]),
  ];

  if (goalTokens.length === 0) return 0;

  let matched = 0;
  for (const token of goalTokens) {
    // Boundary-aware: short tokens (< 4 chars) must match as whole words
    if (token.length < 4) {
      if (hasBoundaryToken(textLower, token)) matched++;
    } else {
      // Longer tokens: standard includes is fine
      if (textLower.includes(token)) matched++;
    }
  }

  // Entity terms: boundary-aware matching
  const dedupedTerms = [...new Set(entityTerms.map((t) => t.toLowerCase()))];
  for (const term of dedupedTerms) {
    if (term.length < 4) {
      if (hasBoundaryToken(textLower, term)) matched++;
    } else {
      if (textLower.includes(term)) matched++;
    }
  }

  // Normalize by total unique query terms
  const totalTerms = goalTokens.length + dedupedTerms.length;
  return Math.min(matched / Math.max(totalTerms, 1), 1.0);
}

// ─── Semantic Similarity (Optional) ────────────────────────

/**
 * Resolve embedding configuration from environment.
 * Priority:
 *   A. Explicit embedding config (PAYLABS_EMBEDDING_*)
 *   B. True OpenAI credentials only (PAYLABS_OPENAI_API_KEY / OPENAI_API_KEY)
 *
 * NEVER uses PAYLABS_LLM_API_KEY_DEFAULT unless provider is confirmed OpenAI.
 */
function resolveEmbeddingConfig(): {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
} | null {
  // A. Explicit embedding config
  const explicitKey =
    process.env.PAYLABS_EMBEDDING_API_KEY ||
    undefined;
  const explicitBase = process.env.PAYLABS_EMBEDDING_BASE_URL || undefined;
  const explicitModel = process.env.PAYLABS_EMBEDDING_MODEL || "text-embedding-3-small";

  if (explicitKey) {
    return { apiKey: explicitKey, baseUrl: explicitBase, model: explicitModel };
  }

  // B. True OpenAI-only credentials (not generic LLM provider keys)
  const openaiKey =
    process.env.PAYLABS_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY;

  if (openaiKey) {
    return { apiKey: openaiKey, baseUrl: undefined, model: explicitModel };
  }

  // No valid embedding config
  return null;
}

/**
 * Compute semantic similarity using OpenAI embeddings.
 * Ephemeral per-run only. No vectors persisted.
 * Returns null if embeddings unavailable or fail.
 *
 * Uses embedQuery() for query and embedDocuments() for chunks.
 */
async function computeSemanticSimilarity(
  queryText: string,
  chunkTexts: string[],
): Promise<(number | null)[]> {
  const config = resolveEmbeddingConfig();
  if (!config?.apiKey) {
    return chunkTexts.map(() => null);
  }

  try {
    const { OpenAIEmbeddings } = await import("@langchain/openai");

    const embeddings = new OpenAIEmbeddings({
      modelName: config.model,
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });

    // Embed query with embedQuery, chunks with embedDocuments
    const queryVector = await embeddings.embedQuery(queryText);
    const chunkVectors = await embeddings.embedDocuments(chunkTexts);

    if (chunkVectors.length !== chunkTexts.length) {
      return chunkTexts.map(() => null);
    }

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
 * Uses active-weight normalization: only dimensions that actually exist
 * in the query contribute to the score. Absent constraints are excluded,
 * not rewarded with perfect scores.
 *
 * Input: RetrievalContext + EvidenceChunk[]
 * Output: RankedEvidenceChunk[] (sorted by score descending)
 */
export async function rankEvidenceChunks(
  retrievalContext: RetrievalContext,
  chunks: EvidenceChunk[],
  options?: { enableSemantic?: boolean; maxSemanticChunks?: number },
): Promise<RankedEvidenceChunk[]> {
  const enableSemantic = options?.enableSemantic !== false;
  const maxSemanticChunks = options?.maxSemanticChunks ?? 35;

  const queryText = retrievalContext.originalGoal;
  const normalizedGoal = retrievalContext.normalizedGoal;
  const requirements: QueryRequirements = retrievalContext.queryRequirements
    ?? extractQueryRequirements(retrievalContext.originalGoal);
  const requiredEntities = requirements.explicitSubjects.filter((e) => e.required);
  const requestedAspects = requirements.requestedAspects;
  const lockedPhrases = retrievalContext.lockedPhrases;
  const entityTerms = [...new Set(requiredEntities.flatMap((entity) => [entity.canonical, entity.text]))];

  // Pre-compute which dimensions are active (have actual constraints)
  const hasRequiredEntities = requiredEntities.length > 0;
  const hasRequestedAspects = requestedAspects.length > 0;
  const hasLockedPhrases = lockedPhrases.length > 0;

  // ── Phase 1: Deterministic support extraction ──
  const relevances: ChunkRelevance[] = chunks.map((chunk) => {
    const text = `${chunk.metadata.title} ${chunk.text}`;

    // Entity support (boundary-aware, from canonical matching)
    const entitySupport: string[] = [];
    for (const entity of requiredEntities) {
      const supportsEntity = entity.type === "named_subject"
        ? matchesExactPhrase(text, entity.canonical)
        : matchesRequiredEntity(text, {
          text: entity.text,
          canonical: entity.canonical,
          type: entity.type,
          required: entity.required,
        });
      if (supportsEntity) {
        entitySupport.push(entity.canonical);
      }
    }

    // Aspect support is the shared RequestedAspectConstraint matcher.
    const aspectSupport = getMatchedAspectsForText(text, requestedAspects);

    // Locked phrase support
    const lockedPhraseSupport = lockedPhrases.filter(
      (phrase: string) => matchesExactPhrase(text, phrase),
    );

    // ── Rejection: no required entity when required entities exist ──
    const hasRequiredEntity = !hasRequiredEntities ||
      requiredEntities.some((e: { canonical: string }) => entitySupport.includes(e.canonical));

    let rejectionReason: string | null = null;
    if (hasRequiredEntities && !hasRequiredEntity) {
      rejectionReason = "missing_required_entity";
    }

    // ── Component scores (0..1 each) ──
    const requiredEntityScore = hasRequiredEntities
      ? (hasRequiredEntity
        ? entitySupport.filter((e: string) => requiredEntities.some((re) => re.canonical === e)).length / requiredEntities.length
        : 0)
      : 0; // INACTIVE → 0, not 1.0

    const aspectScore = hasRequestedAspects
      ? aspectSupport.length / requestedAspects.length
      : 0; // INACTIVE → 0

    const lockedPhraseScore = hasLockedPhrases
      ? lockedPhraseSupport.length / lockedPhrases.length
      : 0; // INACTIVE → 0

    // Lexical overlap (always active)
    const lexicalScore = computeLexicalOverlap(text, queryText, normalizedGoal, entityTerms);

    // Quality score (always active)
    const qualityScore = computeQualityScore(chunk);

    // ── Active-weight normalization ──
    // Build active weight sum from dimensions that actually have constraints
    let activeWeightSum = WEIGHTS.lexical + WEIGHTS.quality; // always active
    let weightedSum =
      WEIGHTS.lexical * lexicalScore +
      WEIGHTS.quality * qualityScore;

    if (hasRequiredEntities) {
      activeWeightSum += WEIGHTS.requiredEntity;
      weightedSum += WEIGHTS.requiredEntity * requiredEntityScore;
    }
    if (hasRequestedAspects) {
      activeWeightSum += WEIGHTS.aspect;
      weightedSum += WEIGHTS.aspect * aspectScore;
    }
    if (hasLockedPhrases) {
      activeWeightSum += WEIGHTS.lockedPhrase;
      weightedSum += WEIGHTS.lockedPhrase * lockedPhraseScore;
    }

    // Normalize: weightedSum / activeWeightSum gives 0..1
    const normalizedScore = activeWeightSum > 0
      ? weightedSum / activeWeightSum
      : 0;

    // ── Penalties ──
    let penalty = 0;

    if (hasRequiredEntities && !hasRequiredEntity) {
      penalty += PENALTY.noRequiredEntity;
    }

    if (entitySupport.length > 0 && aspectSupport.length === 0 && hasRequestedAspects) {
      penalty += PENALTY.entityOnlyNoAspect;
    }

    if (chunk.text.length < 100) {
      penalty += PENALTY.shortChunk;
    }

    if (isGenericBoilerplate(text)) {
      penalty += PENALTY.genericBoilerplate;
    }

    penalty += GRANULARITY_PENALTY[chunk.metadata.evidenceGranularity] || 0;

    const finalScore = Math.max(0, Math.min(1, normalizedScore - penalty));

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

  ranked.sort((a, b) => b.relevance.score - a.relevance.score);

  // Populate chunk metadata support fields
  for (const item of ranked) {
    item.chunk.metadata.entitySupport = item.relevance.entitySupport;
    item.chunk.metadata.aspectSupport = item.relevance.aspectSupport;
  }

  return ranked;
}
