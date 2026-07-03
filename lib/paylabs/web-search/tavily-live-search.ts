/**
 * Tavily Live Search — Safe Query Builder + Result Normalizer
 *
 * Builds a safe Tavily query from user goal + entity terms + detected topics.
 * Normalizes results into the inline candidate shape used by signal_scout.
 *
 * Called ONLY when RSSHub returns 0 AI/Crypto sources.
 * Links-only. No Crawl, Extract, or Map.
 *
 * Safe:
 * - strips wallet addresses, secrets, API keys from query
 * - rejects parked/login/403/404 results
 * - never exposes raw Tavily payload
 * - never logs API keys or raw payload
 */

import { createHash } from "node:crypto";
import { tavilySearch, isTavilyEnabled } from "./tavily-client";

// Re-export isTavilyEnabled for callers
export { isTavilyEnabled } from "./tavily-client";

// ─── Types ──────────────────────────────────────────────────

export interface TavilyLiveCandidate {
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
  rsshub_feed_url: null;
  docs_url: null;
  rank: number;
  relevance_score: number;
  reason: string;
}

export interface TavilyLiveResult {
  candidates: TavilyLiveCandidate[];
  result_count: number;
  latency_ms: number;
  error_class: string | null;
}

// ─── Query Sanitization ─────────────────────────────────────

/** Tokens that indicate sensitive data — must not be sent to Tavily */
const SENSITIVE_PATTERNS = [
  /^0x[0-9a-fA-F]{20,}$/i,          // wallet addresses
  /^(tvly|sk|pk|ghp|gho)[_-]/i,     // API key prefixes
  /^[A-Za-z0-9_-]{40,}$/,            // long opaque tokens
  /bearer\s/i,                        // auth headers
  /authorization/i,                   // auth headers
  /cookie/i,                          // session data
  /private.?key/i,                    // private keys
  /secret/i,                          // secrets
];

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "how", "this", "that",
  "these", "those", "with", "from", "into", "about", "between", "through",
  "after", "before", "above", "below",
  // freshness words removed from stopwords — preserved for Advanced queries
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "not", "no", "but", "if",
  "so", "than", "too", "very", "just", "about", "and", "or", "in", "on",
  "to", "for", "of", "at", "by", "it", "its",
]);

/** Freshness intent words — preserved in Advanced queries, detected for Tavily freshness param */
const FRESHNESS_WORDS = new Set([
  "latest", "recent", "current", "developments", "today", "newest",
  "new", "breaking", "emerging", "trending", "upcoming",
]);

/** Topic-specific relevance terms for Advanced quality guard */
const RELEVANCE_TERMS_MAP: Record<string, string[]> = {
  ai: [
    "ai", "artificial intelligence", "machine learning", "deep learning",
    "llm", "large language model", "neural network", "transformer",
    "openai", "anthropic", "claude", "gemini", "gpt", "chatgpt",
    "langgraph", "langchain", "crewai", "autogen", "open source",
    "agent", "framework", "model", "research", "automation",
    "huggingface", "diffusion", "copilot", "assistant",
  ],
  crypto: [
    "crypto", "cryptocurrency", "blockchain", "bitcoin", "btc", "ethereum",
    "eth", "solana", "defi", "web3", "nft", "token", "stablecoin",
    "usdc", "usdt", "binance", "coinbase", "exchange", "wallet",
    "mining", "staking", "validator", "smart contract", "layer 2",
    "rollup", "arbitrum", "optimism", "base", "polygon",
    "airdrop", "altcoin", "etf", "sec", "regulation",
  ],
};

function isSensitiveToken(token: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(token));
}

/**
 * Detect freshness intent from user query.
 * Returns true if the query asks for latest/recent/current information.
 */
export function detectFreshnessIntent(userGoal: string): boolean {
  const lower = userGoal.toLowerCase();
  return [...FRESHNESS_WORDS].some((w) => lower.includes(w));
}

/**
 * Advanced relevance guard — checks if a Tavily result is topically relevant.
 * At least one RELEVANCE_TERM must appear in title, summary, domain, or URL.
 * Returns { pass, matched_terms } for diagnostic logging.
 */
export function passesAdvancedRelevanceGuard(
  result: { title: string; summary: string; domain: string | null; url: string },
  topicCategory: string,
): { pass: boolean; matched_terms: string[] } {
  const terms = RELEVANCE_TERMS_MAP[topicCategory] || [];
  if (terms.length === 0) return { pass: true, matched_terms: [] };

  const haystack = [
    result.title || "",
    result.summary || "",
    result.domain || "",
    result.url || "",
  ].join(" ").toLowerCase();

  const matched = terms.filter((term) => haystack.includes(term));
  // Require at least 1 relevance term match
  return { pass: matched.length > 0, matched_terms: matched.slice(0, 5) };
}

/**
 * Build a safe Tavily query from user goal + entity terms + detected topics.
 * Strips wallet addresses, secrets, API keys. Max 8 meaningful terms.
 */
export function buildSafeTavilyQuery(input: {
  userGoal: string;
  entityTerms: string[];
  topicCategory: string;
  topicSubcategory?: string;
  /** When true, preserves freshness words (latest, recent, etc.) in query */
  preserveFreshness?: boolean;
}): string {
  const parts: string[] = [];
  const isFresh = input.preserveFreshness || false;

  // 1. Add safe entity terms first (most specific)
  for (const term of input.entityTerms) {
    if (parts.length >= 8) break;
    const t = term.trim();
    if (!t || t.length < 2) continue;
    if (isSensitiveToken(t)) continue;
    if (STOPWORDS.has(t.toLowerCase())) continue;
    parts.push(t);
  }

  // 2. Add topic subcategory if not already present
  if (input.topicSubcategory && parts.length < 8) {
    const sub = input.topicSubcategory.toLowerCase();
    const alreadyIncluded = parts.some((p) => p.toLowerCase().includes(sub));
    if (!alreadyIncluded && !STOPWORDS.has(sub)) {
      parts.push(input.topicSubcategory);
    }
  }

  // 3. If still under 8, add meaningful words from userGoal
  //    For Advanced (preserveFreshness), freshness words are included
  if (parts.length < 8 && input.userGoal) {
    const words = input.userGoal
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => {
        if (w.length <= 3) return false;
        if (isSensitiveToken(w)) return false;
        // For Advanced: keep freshness words, only strip true stopwords
        if (isFresh && FRESHNESS_WORDS.has(w)) return true;
        return !STOPWORDS.has(w);
      });
    for (const word of words) {
      if (parts.length >= 8) break;
      const alreadyIncluded = parts.some((p) => p.toLowerCase() === word);
      if (!alreadyIncluded) {
        parts.push(word);
      }
    }
  }

  return parts.join(" ").trim() || input.topicCategory;
}

// ─── Result Quality Guard ───────────────────────────────────

/** Domains that are known low-quality or parked */
const REJECTED_DOMAIN_PATTERNS = [
  /hostinger/i,
  /parked/i,
  /domain.?for.?sale/i,
  /coming.?soon/i,
  /godaddy.?parked/i,
  /arclayer\.io/i,  // known parked domain
];

/** Title patterns that indicate low-quality or gated pages */
const REJECTED_TITLE_PATTERNS = [
  /^(login|sign in|sign up|register|403|404|access denied|forbidden)/i,
  /^(page not found|error|unavailable|maintenance)/i,
  /domain.?for.?sale/i,
  /coming.?soon/i,
  /parked.?domain/i,
];

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type TavilyRejectionReason =
  | "invalid_url"
  | "empty_title"
  | "no_domain"
  | "rejected_domain"
  | "rejected_title"
  | "empty_content_required"
  | null;

function passesTavilyQualityGuard(result: {
  title: string;
  url: string;
  content: string;
  domain: string | null;
}): { pass: boolean; reason: TavilyRejectionReason } {
  // Must have valid HTTP(S) URL
  if (!/^https?:\/\//.test(result.url)) return { pass: false, reason: "invalid_url" };

  // Must have non-empty title
  if (!result.title || result.title.trim().length === 0) return { pass: false, reason: "empty_title" };

  // Must have domain
  if (!result.domain) return { pass: false, reason: "no_domain" };

  // Reject parked/dead domains
  if (REJECTED_DOMAIN_PATTERNS.some((re) => re.test(result.domain!))) return { pass: false, reason: "rejected_domain" };
  if (REJECTED_DOMAIN_PATTERNS.some((re) => re.test(result.title))) return { pass: false, reason: "rejected_domain" };

  // Reject login/gated pages
  if (REJECTED_TITLE_PATTERNS.some((re) => re.test(result.title))) return { pass: false, reason: "rejected_title" };

  // Content length: only reject if content is completely empty (not just short).
  // Tavily Search "basic" depth often returns short snippets (< 20 chars).
  // A valid URL + title + domain + score is sufficient for links-only fallback.
  if (!result.content || result.content.trim().length === 0) return { pass: false, reason: "empty_content_required" };

  return { pass: true, reason: null };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Fetch live web search results from Tavily for an AI/Crypto topic.
 * Called ONLY when RSSHub returns 0 relevant sources.
 *
 * @returns TavilyLiveResult with normalized candidates
 */
export async function fetchTavilyLiveSources(input: {
  userGoal: string;
  entityTerms: string[];
  topicCategory: string;
  topicSubcategory?: string;
  callerTag?: string;
  /** Pass route tier to enable Advanced-specific behavior */
  routeTier?: string;
}): Promise<TavilyLiveResult> {
  const emptyResult: TavilyLiveResult = {
    candidates: [],
    result_count: 0,
    latency_ms: 0,
    error_class: null,
  };

  if (!isTavilyEnabled()) {
    return { ...emptyResult, error_class: "tavily_disabled" };
  }

  const callerTag = input.callerTag || "tavily_live";
  const isAdvanced = input.routeTier === "advanced";
  const freshnessDetected = detectFreshnessIntent(input.userGoal);

  const safeQuery = buildSafeTavilyQuery({
    ...input,
    preserveFreshness: isAdvanced,
  });

  if (!safeQuery) {
    return { ...emptyResult, error_class: "empty_query" };
  }

  // Pass freshness to Tavily API when Advanced + freshness intent detected
  const tavilyFreshness = isAdvanced && freshnessDetected ? "week" : undefined;
  const tavilyResponse = await tavilySearch(safeQuery, tavilyFreshness);

  if (!tavilyResponse.ok || tavilyResponse.result_count === 0) {
    return {
      ...emptyResult,
      latency_ms: tavilyResponse.latency_ms,
      error_class: tavilyResponse.error_class,
    };
  }

  // Normalize results into inline candidate shape
  const candidates: TavilyLiveCandidate[] = [];
  const seenUrls = new Set<string>();
  const rejectionReasonCounts: Record<string, number> = {};
  let advancedRelevanceRejectionCount = 0;

  for (let i = 0; i < tavilyResponse.results.length; i++) {
    const r = tavilyResponse.results[i];
    const domain = extractDomain(r.url);

    // Quality guard (returns structured rejection reason for diagnostics)
    const guard = passesTavilyQualityGuard({ title: r.title, url: r.url, content: r.content, domain });
    if (!guard.pass) {
      const reasonKey = guard.reason || "unknown";
      rejectionReasonCounts[reasonKey] = (rejectionReasonCounts[reasonKey] || 0) + 1;
      continue;
    }

    // Dedupe by URL
    const urlLower = r.url.toLowerCase();
    if (seenUrls.has(urlLower)) continue;
    seenUrls.add(urlLower);

    // Advanced relevance guard: check topically relevant
    if (isAdvanced) {
      const relevanceGuard = passesAdvancedRelevanceGuard(
        { title: r.title, summary: r.content, domain, url: r.url },
        input.topicCategory,
      );
      if (!relevanceGuard.pass) {
        advancedRelevanceRejectionCount++;
        continue;
      }
    }

    const feedItemId = `tavily_live:${createHash("sha256").update(r.url).digest("hex").slice(0, 16)}`;

    candidates.push({
      feed_item_id: feedItemId,
      title: r.title || "(untitled)",
      publisher: domain || "web",
      source_kind: "tavily_live",
      provider: "tavily",
      source_url: r.url,
      domain,
      summary: (r.content || "").slice(0, 500),
      author: "",
      published_at: r.published_date || null,
      route_path: null,
      rsshub_feed_url: null,
      docs_url: null,
      rank: candidates.length + 1,
      relevance_score: typeof r.score === "number" ? r.score : 0.5,
      reason: `tavily_live:${input.topicCategory}/${input.topicSubcategory || "general"}`,
    });
  }

  // Assign final ranks
  candidates.forEach((c, i) => { c.rank = i + 1; });

  // Safe diagnostic log — includes rejection reasons, freshness, relevance
  const safeLog: Record<string, unknown> = {
    log: `[${callerTag}] tavily_search_complete`,
    query_topic: `${input.topicCategory}/${input.topicSubcategory || "general"}`,
    tavily_safe_query: safeQuery,
    freshness_intent_detected: freshnessDetected,
    tavily_freshness_param: tavilyFreshness || null,
    route_tier: input.routeTier || "unknown",
    tavily_raw_result_count: tavilyResponse.result_count,
    tavily_accepted_count: candidates.length,
    latency_ms: tavilyResponse.latency_ms,
    domains: candidates.map((c) => c.domain).filter(Boolean).slice(0, 5),
  };
  // Add rejection breakdown when raw results > 0 but accepted = 0
  if (tavilyResponse.result_count > 0 && candidates.length === 0) {
    safeLog.tavily_rejection_reason_counts = rejectionReasonCounts;
  }
  // Always log advanced relevance rejections when Advanced
  if (isAdvanced && advancedRelevanceRejectionCount > 0) {
    safeLog.advanced_relevance_rejection_counts = advancedRelevanceRejectionCount;
  }
  console.log(JSON.stringify(safeLog));

  return {
    candidates,
    result_count: candidates.length,
    latency_ms: tavilyResponse.latency_ms,
    error_class: candidates.length === 0 ? "all_results_filtered" : null,
  };
}
