/**
 * Topic-Based Route Registry
 *
 * Maps user topic keywords to curated RSSHub routes.
 * Used as priority candidates when the user query matches a known topic.
 * Falls back to dynamic catalog search if no topic matches.
 *
 * All routes validated on rsshub.rssforever.com (2026-06).
 * Broken routes (503/timeout) are excluded.
 *
 * No LLM. No secrets. No raw payload exposure.
 */

// ─── Types ──────────────────────────────────────────────────

export interface TopicRoute {
  /** RSSHub route path (static, no params) */
  path: string;
  /** Human-readable label */
  label: string;
  /** Topic category this route belongs to */
  category: "ai" | "crypto";
  /** Subcategory for finer grouping */
  subcategory: string;
  /** Whether this route was validated as working */
  validated: boolean;
}

// ─── AI Routes ──────────────────────────────────────────────

const AI_ROUTES: TopicRoute[] = [
  // AIBase — Chinese AI news aggregator
  { path: "/aibase/news", label: "AIBase News", category: "ai", subcategory: "news", validated: true },
  { path: "/aibase/topic/AI%E5%8A%A9%E6%89%8B", label: "AIBase AI Assistants", category: "ai", subcategory: "assistants", validated: true },
  { path: "/aibase/topic/%E8%AF%AD%E8%A8%80%E6%A8%A1%E5%9E%8B", label: "AIBase Language Models", category: "ai", subcategory: "llm", validated: true },
  { path: "/aibase/topic/%E8%87%AA%E5%8A%A8%E5%8C%96", label: "AIBase Automation", category: "ai", subcategory: "automation", validated: true },
  { path: "/aibase/topic/%E5%A4%A7%E5%9E%8B%E8%AF%AD%E8%A8%80%E6%A8%A1%E5%9E%8B", label: "AIBase Large Language Models", category: "ai", subcategory: "llm", validated: true },

  // OpenAI — official
  { path: "/openai/news", label: "OpenAI News", category: "ai", subcategory: "openai", validated: true },
  { path: "/openai/research", label: "OpenAI Research", category: "ai", subcategory: "research", validated: true },
  { path: "/openai/chatgpt/release-notes", label: "ChatGPT Release Notes", category: "ai", subcategory: "chatgpt", validated: true },
];

// ─── Crypto Routes ──────────────────────────────────────────

const CRYPTO_ROUTES: TopicRoute[] = [
  // CoinDesk
  { path: "/coindesk/news", label: "CoinDesk News", category: "crypto", subcategory: "news", validated: true },
  { path: "/coindesk/consensus-magazine", label: "CoinDesk Consensus Magazine", category: "crypto", subcategory: "magazine", validated: true },

  // Cointelegraph
  { path: "/cointelegraph", label: "Cointelegraph", category: "crypto", subcategory: "news", validated: true },

  // CryptoSlate
  { path: "/cryptoslate", label: "CryptoSlate", category: "crypto", subcategory: "news", validated: true },

  // The Block
  { path: "/theblock/category/crypto-ecosystems", label: "The Block: Crypto Ecosystems", category: "crypto", subcategory: "ecosystems", validated: true },
  { path: "/theblock/category/policy", label: "The Block: Policy", category: "crypto", subcategory: "policy", validated: true },
  { path: "/theblock/category/companies", label: "The Block: Companies", category: "crypto", subcategory: "companies", validated: true },

  // Binance Announcements
  { path: "/binance/announcement/new-cryptocurrency-listing/en", label: "Binance New Listings", category: "crypto", subcategory: "binance", validated: true },
  { path: "/binance/announcement/latest-binance-news/en", label: "Binance Latest News", category: "crypto", subcategory: "binance", validated: true },
  { path: "/binance/announcement/crypto-airdrop/en", label: "Binance Airdrops", category: "crypto", subcategory: "binance", validated: true },
  { path: "/binance/announcement/delisting/en", label: "Binance Delistings", category: "crypto", subcategory: "binance", validated: true },
];

// ─── Topic Detection ────────────────────────────────────────

/** Keyword → topic mapping. Order matters: first match wins. */
const TOPIC_KEYWORDS: Array<{ keywords: string[]; category: "ai" | "crypto"; subcategory?: string }> = [
  // AI — broad
  { keywords: ["artificial intelligence", "machine learning", "deep learning", "neural network", "ai news", "ai research", "ai model", "ai tool", "ai agent"], category: "ai" },
  // AI — specific
  { keywords: ["openai", "chatgpt", "gpt-4", "gpt-5", "dall-e", "sora", "whisper", "gpt"], category: "ai", subcategory: "openai" },
  { keywords: ["llm", "large language model", "language model", "foundation model", "transformer"], category: "ai", subcategory: "llm" },
  { keywords: ["ai assistant", "ai chatbot", "copilot", "ai helper"], category: "ai", subcategory: "assistants" },
  { keywords: ["ai automation", "automated", "workflow automation", "ai workflow"], category: "ai", subcategory: "automation" },
  { keywords: ["claude", "anthropic", "gemini", "google ai", "midjourney", "stable diffusion", "ai image", "ai video", "ai audio"], category: "ai" },

  // Crypto — broad
  { keywords: ["cryptocurrency", "crypto news", "crypto market", "blockchain", "defi", "decentralized finance", "web3", "nft", "token", "altcoin"], category: "crypto" },
  // Crypto — specific
  { keywords: ["bitcoin", "btc", "ethereum", "eth", "solana", "sol"], category: "crypto", subcategory: "news" },
  { keywords: ["binance", "coinbase", "kraken", "exchange"], category: "crypto", subcategory: "binance" },
  { keywords: ["airdrop", "token listing", "delisting", "new coin"], category: "crypto", subcategory: "binance" },
  { keywords: ["crypto regulation", "crypto policy", "sec crypto", "crypto law"], category: "crypto", subcategory: "policy" },
  { keywords: ["crypto company", "crypto startup", "crypto funding", "crypto investment"], category: "crypto", subcategory: "companies" },
  { keywords: ["stablecoin", "usdc", "usdt", "dai"], category: "crypto" },
  { keywords: ["x402", "nanopayment", "nanopayments", "payment protocol", "micropayment", "pay-per-request"], category: "crypto", subcategory: "news" },
  { keywords: ["circle", "circle financial", "circle usdc", "circle gateway", "circle wallet"], category: "crypto", subcategory: "news" },
  { keywords: ["gateway", "gateway wallet", "gateway deposit", "unified balance"], category: "crypto", subcategory: "ecosystems" },
  { keywords: ["arc", "arc blockchain", "arc testnet", "arc layer"], category: "crypto", subcategory: "ecosystems" },
  { keywords: ["aws waf", "cloudflare", "bot monetization", "api monetization"], category: "crypto", subcategory: "news" },
  { keywords: ["ai agent payment", "ai agent wallet", "agent commerce", "agentic payment"], category: "crypto", subcategory: "news" },
];

// ─── Public API ─────────────────────────────────────────────

/**
 * Detect topics from user query and entity terms.
 * Returns matched topic categories with optional subcategory hints.
 */
export function detectTopics(
  userGoal: string,
  entityTerms: string[]
): Array<{ category: "ai" | "crypto"; subcategory?: string }> {
  const allText = [userGoal, ...entityTerms].join(" ").toLowerCase();
  const matches: Array<{ category: "ai" | "crypto"; subcategory?: string }> = [];
  const seen = new Set<string>();

  for (const entry of TOPIC_KEYWORDS) {
    const matched = entry.keywords.some((kw) => allText.includes(kw.toLowerCase()));
    if (matched) {
      const key = `${entry.category}:${entry.subcategory || "*"}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ category: entry.category, subcategory: entry.subcategory });
      }
    }
  }

  return matches;
}

/**
 * Get curated routes for detected topics.
 * Returns validated routes filtered by category/subcategory.
 *
 * @param topics - from detectTopics()
 * @param maxRoutes - max routes to return (default 8)
 */
export function getTopicRoutes(
  topics: Array<{ category: "ai" | "crypto"; subcategory?: string }>,
  maxRoutes = 8
): TopicRoute[] {
  if (topics.length === 0) return [];

  const allRoutes = [...AI_ROUTES, ...CRYPTO_ROUTES];
  const matched: TopicRoute[] = [];
  const seenPaths = new Set<string>();

  for (const topic of topics) {
    const categoryRoutes = allRoutes.filter((r) => r.category === topic.category);

    // If subcategory specified, prioritize those routes
    if (topic.subcategory) {
      const subRoutes = categoryRoutes.filter(
        (r) => r.subcategory === topic.subcategory && r.validated
      );
      for (const r of subRoutes) {
        if (!seenPaths.has(r.path) && matched.length < maxRoutes) {
          seenPaths.add(r.path);
          matched.push(r);
        }
      }
    }

    // Always include top-level category routes (news, general)
    const generalRoutes = categoryRoutes.filter(
      (r) =>
        r.validated &&
        (r.subcategory === "news" || r.subcategory === "magazine") &&
        !seenPaths.has(r.path)
    );
    for (const r of generalRoutes) {
      if (matched.length < maxRoutes) {
        seenPaths.add(r.path);
        matched.push(r);
      }
    }
  }

  return matched.slice(0, maxRoutes);
}

/**
 * Full pipeline: detect topics → get routes.
 * Returns empty array if no topics detected.
 */
export function resolveTopicRoutes(
  userGoal: string,
  entityTerms: string[],
  maxRoutes = 8
): TopicRoute[] {
  const topics = detectTopics(userGoal, entityTerms);
  return getTopicRoutes(topics, maxRoutes);
}
