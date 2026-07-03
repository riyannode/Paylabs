/**
 * Topic Source Guards — Shared Helper
 *
 * Domain-based guards for AI and crypto topic queries.
 * Prevents wrong-domain sources from leaking when topic routes return 0 candidates
 * and regular live search fallback produces irrelevant results.
 *
 * Used by:
 *   - rsshub-topic-live-search.ts (topic route item filtering)
 *   - signal-scout-basics.ts (Easy tier non-topic candidate filtering)
 *   - signal-scout.ts (Normal/Advanced tier non-topic candidate filtering)
 *   - source-resolver.ts (final resolver-level guard)
 *
 * No LLM. No secrets. No raw payload exposure.
 */

// ─── Domain Sets ──────────────────────────────────────────

/** AI topic: domains that are always allowed */
export const AI_ALLOWED_DOMAINS = new Set([
  "openai.com", "help.openai.com",
  "aibase.com", "top.aibase.com",
  "huggingface.co",
  "arxiv.org",
  "research.google",
]);

/** AI topic: conditional domains — allowed only when route path matches */
export const AI_CONDITIONAL_DOMAINS: Record<string, (routePath: string) => boolean> = {
  "arxiv.org": (rp) => rp.startsWith("/huggingface/daily-papers"),
  "research.google": (rp) => rp === "/google/research",
};

/** Strong AI terms — generic news domains must have these in title/summary to pass */
export const STRONG_AI_TERMS = [
  "ai", "artificial intelligence", "openai", "chatgpt", "gpt", "llm",
  "machine learning", "model", "claude", "anthropic", "gemini",
  "huggingface", "research", "deep learning", "neural",
  "transformer", "diffusion", "language model",
];

/** Crypto topic: explicitly allowed domains */
export const CRYPTO_ALLOWED_DOMAINS = new Set([
  "coindesk.com", "www.coindesk.com",
  "cointelegraph.com", "www.cointelegraph.com",
  "cryptoslate.com", "www.cryptoslate.com",
  "theblock.co", "www.theblock.co",
  "binance.com", "www.binance.com",
]);

/** Strong crypto terms — generic domains must have these in title/summary to pass */
const STRONG_CRYPTO_TERMS_RE = /\b(crypto|bitcoin|ethereum|blockchain|defi|web3|token|stablecoin|usdc|binance|staking|stake|validator|rollup|layer\s?[12]|l[12]|scaling|scalability|etf|eigenlayer|lido|arbitrum|optimism|polygon|zksync|starknet|modular blockchain|data availability)\b/i;

// ─── Helpers ──────────────────────────────────────────────

function isDomainOrSubdomainOf(input: string, base: string): boolean {
  const raw = input.toLowerCase().trim();
  const b = base.toLowerCase();
  return raw === b || raw.endsWith(`.${b}`);
}

function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Strong AI term boundary check — short terms (≤3 chars) need word boundaries */
function hasStrongAiTerm(text: string): boolean {
  const lower = text.toLowerCase();
  return STRONG_AI_TERMS.some((t) => {
    if (t.length <= 3) {
      return new RegExp(
        `(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
        "i"
      ).test(lower);
    }
    return lower.includes(t);
  });
}

// ─── Public Guards ────────────────────────────────────────

/**
 * Check if a source passes the AI domain guard.
 * - Always-allowed AI domains: always pass
 * - Conditional domains (arxiv, research.google): pass only with matching route
 * - Generic domains: pass only if title/summary has strong AI terms
 */
export function passesAiSourceGuard(input: {
  domain: string;
  routePath?: string;
  title?: string;
  summary?: string;
}): boolean {
  const d = (input.domain || "").toLowerCase();
  const rp = input.routePath || "";
  const combined = `${input.title || ""} ${input.summary || ""}`;

  // Always-allowed domains
  for (const allowed of AI_ALLOWED_DOMAINS) {
    if (isDomainOrSubdomainOf(d, allowed)) return true;
  }
  // Conditional domains
  for (const [condDomain, check] of Object.entries(AI_CONDITIONAL_DOMAINS)) {
    if (isDomainOrSubdomainOf(d, condDomain) && check(rp)) return true;
  }
  // Generic domain: require strong AI terms in title/summary
  return hasStrongAiTerm(combined);
}

/**
 * Check if a source passes the crypto domain guard.
 * - Crypto route paths: always pass
 * - Explicitly allowed crypto domains: always pass
 * - Generic domains: pass only if title/summary has strong crypto terms
 */
export function passesCryptoSourceGuard(input: {
  domain: string;
  routePath?: string;
  title?: string;
  summary?: string;
}): boolean {
  const d = (input.domain || "").toLowerCase();
  const rp = input.routePath || "";
  const combined = `${input.title || ""} ${input.summary || ""}`;

  // Crypto route paths
  if (
    rp.startsWith("/coindesk/") || rp.startsWith("/cointelegraph") ||
    rp.startsWith("/cryptoslate") || rp.startsWith("/theblock/") ||
    rp.startsWith("/binance/")
  ) return true;

  // Explicitly allowed domains
  for (const allowed of CRYPTO_ALLOWED_DOMAINS) {
    if (isDomainOrSubdomainOf(d, allowed)) return true;
  }
  // Generic domain: require strong crypto terms
  return STRONG_CRYPTO_TERMS_RE.test(combined);
}

/**
 * Check if a source is a generic catch-all (Wikipedia current-events, etc.)
 * that should be rejected when domain-specific topic routes exist.
 */
export function isGenericCatchAllSource(input: {
  domain?: string;
  routePath?: string;
  url?: string;
}): boolean {
  const url = (input.url || "").toLowerCase();
  const rp = (input.routePath || "").toLowerCase();
  const domain = (input.domain || "").toLowerCase();

  return (
    /\/wiki.*current.events/i.test(url) ||
    /\/wiki.*current.events/i.test(rp) ||
    /\/wiki.*in.the.news/i.test(url) ||
    /\/wiki.*in.the.news/i.test(rp) ||
    (/en\.wikipedia\.org/i.test(domain) && /current/i.test(rp))
  );
}

/**
 * Detect domain topic from query — returns { hasAi, hasCrypto } flags.
 * Uses detectTopics internally. Import detectTopics from topic-routes if needed.
 */
export function detectDomainTopics(
  topics: Array<{ category: string; subcategory?: string }>
): { hasAi: boolean; hasCrypto: boolean } {
  return {
    hasAi: topics.some((t) => t.category === "ai"),
    hasCrypto: topics.some((t) => t.category === "crypto"),
  };
}
