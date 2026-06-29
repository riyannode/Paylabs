/**
 * Source Term Matching — Shared helpers for entity term sanitization
 * and boundary-aware keyword matching.
 *
 * Used by: source-resolver, topic-routes, rsshub-route-search,
 *          signal-scout-basics, signal-scout, rsshub-live-search
 *
 * No LLM. No secrets. Deterministic.
 */

// ─── Constants ──────────────────────────────────────────────

/** Constraint/internal tokens from query_builder that are NOT real entities */
const CONSTRAINT_TOKENS = new Set([
  "recency_priority", "trust_required", "source_required",
  "budget_required", "verification_required", "payment_required",
  "creator_required", "free_only", "quality_priority",
]);

/** Sentence starters / stopwords — must never be treated as entity terms */
const STOPWORDS = new Set([
  // English
  "what", "how", "why", "who", "when", "where",
  "are", "is", "the", "a", "an", "to", "for", "of",
  "and", "or", "in", "on", "with", "from", "by", "at", "it",
  "this", "that", "these", "those", "be", "was", "were", "been",
  "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall",
  "not", "no", "but", "if", "so", "than", "too", "very",
  "just", "about", "into", "over", "after", "before",
  // Indonesian
  "cari", "source", "sumber", "terbaru", "terkini",
  "latest", "recent", "new", "news", "update", "updates",
  "apa", "siapa", "kapan", "dimana", "mengapa", "bagaimana",
  "adalah", "yang", "ini", "itu", "dan", "atau", "di", "ke",
  "dari", "dengan", "untuk", "pada", "oleh",
  // Generic query words
  "search", "find", "get", "show", "list", "tell", "give",
  "please", "help", "need", "want", "looking",
]);

/** Known real entity terms — always keep even if they look short */
const KNOWN_ENTITIES = new Set([
  "x402", "usdc", "aws", "waf", "llm", "ai", "api",
  "evm", "arc", "circle", "gateway", "ethereum", "bitcoin",
  "openai", "cloudflare", "solana", "nft", "defi", "web3",
  "gpt", "ml", "btc", "eth", "sol", "dao", "dex", "l2",
  "cefi", "cv", "cdns", "anthropic", "claude", "gemini",
  "binance", "coinbase", "stripe", "supabase", "vercel",
  "langchain", "langgraph", "mcp",
]);

// ─── Core Helpers ───────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a term appears as a whole word (not inside another word).
 * For terms <= 3 chars, always require boundary.
 * For longer terms, use plain includes (substring is fine for 4+ char words).
 */
export function hasBoundaryTerm(text: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  // Short tokens (<=3 chars): always require boundary
  if (t.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}([^a-z0-9]|$)`, "i").test(text);
  }
  // Longer tokens: plain includes is fine
  return text.toLowerCase().includes(t);
}

/**
 * Boundary-aware keyword matching for topic detection.
 * Single-word keywords must not match inside other words.
 * Multi-word keywords get boundary checks on first and last word.
 */
export function keywordMatches(allText: string, keyword: string): boolean {
  const kw = keyword.toLowerCase().trim();
  if (!kw) return false;
  const text = allText.toLowerCase();

  if (kw.includes(" ")) {
    // Multi-word: check that first word has left boundary and last word has right boundary
    const words = kw.split(/\s+/);
    const firstWord = words[0];
    const lastWord = words[words.length - 1];

    // Find the phrase in text
    let idx = text.indexOf(kw);
    while (idx !== -1) {
      const beforeChar = idx > 0 ? text[idx - 1] : " ";
      const afterIdx = idx + kw.length;
      const afterChar = afterIdx < text.length ? text[afterIdx] : " ";

      const leftBoundary = /[^a-z0-9]/.test(beforeChar);
      const rightBoundary = /[^a-z0-9]/.test(afterChar);

      if (leftBoundary && rightBoundary) return true;
      idx = text.indexOf(kw, idx + 1);
    }
    return false;
  }

  // Single word: boundary match
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(kw)}([^a-z0-9]|$)`, "i").test(allText);
}

/**
 * Check if a string is a meaningful entity term (not a constraint, stopword, or filler).
 */
export function isMeaningfulEntityTerm(term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (CONSTRAINT_TOKENS.has(t)) return false;
  if (STOPWORDS.has(t)) return false;
  if (KNOWN_ENTITIES.has(t)) return true;
  // Capitalized/product terms: keep if not a stopword
  if (term.length > 1 && /^[A-Z]/.test(term) && !STOPWORDS.has(t)) return true;
  // Short tokens that are known entities
  if (t.length <= 3 && KNOWN_ENTITIES.has(t)) return true;
  // Generic short tokens that aren't known entities: drop
  if (t.length <= 2 && !KNOWN_ENTITIES.has(t)) return false;
  return true;
}

/**
 * Sanitize entity terms: remove constraints, stopwords, and non-entities.
 * Deduplicates case-insensitively.
 * Returns empty array if no meaningful terms remain.
 */
export function sanitizeEntityTerms(input: string[]): string[] {
  if (!input || input.length === 0) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of input) {
    const t = term?.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    if (isMeaningfulEntityTerm(t)) {
      result.push(t);
    }
  }

  return result;
}
