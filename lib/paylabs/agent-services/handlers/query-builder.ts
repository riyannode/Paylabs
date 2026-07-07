/**
 * Query Builder Handler — v2 (Structured Entities)
 *
 * Reuses: query_expander
 * Macro-node: discovery_planner
 * Execution modes:
 *   - deterministic (default): deterministic query expansion from goal + topics
 *   - llm: LLM-powered query expansion
 *   - hybrid: deterministic + LLM enrichment
 *
 * Expands normalized goal into source discovery queries.
 * v2: Outputs structured entities with type/required metadata.
 *     Phrase locking is the source of truth — locked phrases flow directly
 *     into primary_entities without splitting into individual tokens.
 *     entity_terms remains as computed compatibility field.
 */

import { z } from "zod";
import type { ServiceHandler, ServiceHandlerInput, ServiceHandlerOutput } from "../types";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { shouldRunServiceAsDeterministic } from "../execution-mode";

// ─── Schemas ───────────────────────────────────────────────

const StructuredEntitySchema = z.object({
  text: z.string(),
  canonical: z.string(),
  type: z.string(),
  required: z.boolean(),
});

const QueryBuilderSchema = z.object({
  // Structured entities (v2)
  primary_entities: z.array(StructuredEntitySchema),
  secondary_entities: z.array(StructuredEntitySchema),
  topics: z.array(z.string()),
  locked_phrases: z.array(z.string()),
  negative_entities: z.array(z.string()),
  // Compatibility fields (computed)
  entity_terms: z.array(z.string()),
  expanded_queries: z.array(z.string()),
  negative_filters: z.array(z.string()),
  source_preferences: z.array(z.string()),
  safe_summary: z.string(),
});

// ─── Meaningful Short Tokens ───────────────────────────────

const MEANINGFUL_SHORT_TOKENS = new Set([
  // Original
  "ai", "ml", "llm", "btc", "eth", "sol", "nft", "dao", "dex",
  "api", "usdc", "x402", "evm", "l2", "cefi", "gpt", "cv",
  "waf", "aws", "cdns", "crypto", "defi", "web3",
  // Crypto
  "meme", "rwa", "etf", "otc", "p2p", "tvl", "apy", "apr",
  "cex", "fiat", "mint", "burn", "swap", "stake", "yield",
  // AI
  "mcp", "rag", "agi", "rl", "rlhf", "lora", "gguf", "gptq",
  "vllm", "cuda", "onnx", "whisper", "clip", "sam",
  // Protocols / products
  "solana", "polygon", "avalanche", "arbitrum", "optimism",
  "copilot", "cursor", "sonnet", "claude", "gemini", "gemma",
  "stablecoin", "firedancer", "helius", "jito", "marinade",
  // Circle ecosystem
  "cctp", "dcw", "ucw", "tmv2",
]);

// ─── Entity Lookup (multi-word aliases supported) ──────────

const ENTITY_ALIASES: Record<string, { canonical: string; type: string }> = {
  // Multi-word phrases (order matters — longer phrases first for matching)
  "circle gateway": { canonical: "Circle Gateway", type: "product" },
  "coinbase x402": { canonical: "Coinbase x402", type: "protocol" },
  "openai codex": { canonical: "OpenAI Codex", type: "product" },
  "claude code": { canonical: "Claude Code", type: "product" },
  "model context protocol": { canonical: "MCP", type: "protocol" },
  "developer controlled wallets": { canonical: "DCW", type: "product" },
  "solana firedancer": { canonical: "Solana Firedancer", type: "client" },
  "trust wallet": { canonical: "Trust Wallet", type: "product" },
  // Single tokens
  "x402": { canonical: "x402", type: "protocol" },
  "cctp": { canonical: "CCTP", type: "protocol" },
  "mcp": { canonical: "MCP", type: "protocol" },
  "erc-8004": { canonical: "ERC-8004", type: "standard" },
  "erc-8183": { canonical: "ERC-8183", type: "standard" },
  "usdc": { canonical: "USDC", type: "token" },
  "circle": { canonical: "Circle", type: "company" },
  "coinbase": { canonical: "Coinbase", type: "company" },
  "openai": { canonical: "OpenAI", type: "company" },
  "anthropic": { canonical: "Anthropic", type: "company" },
  "google": { canonical: "Google", type: "company" },
  "solana": { canonical: "Solana", type: "chain" },
  "ethereum": { canonical: "Ethereum", type: "chain" },
  "bitcoin": { canonical: "Bitcoin", type: "chain" },
  "gpt": { canonical: "GPT", type: "model" },
  "gpt-4": { canonical: "GPT-4", type: "model" },
  "claude": { canonical: "Claude", type: "model" },
  "gemini": { canonical: "Gemini", type: "model" },
  "dcw": { canonical: "DCW", type: "product" },
  "ucw": { canonical: "UCW", type: "product" },
  "tmv2": { canonical: "TMV2", type: "contract" },
  "firedancer": { canonical: "Firedancer", type: "client" },
  "copilot": { canonical: "Copilot", type: "product" },
  "cursor": { canonical: "Cursor", type: "product" },
  "sonnet": { canonical: "Sonnet", type: "model" },
  "stablecoin": { canonical: "Stablecoin", type: "concept" },
};

// Pre-sort alias keys by length (longest first) for greedy matching
const ALIAS_KEYS_SORTED = Object.keys(ENTITY_ALIASES).sort(
  (a, b) => b.length - a.length
);

// ─── Sentence Openers ──────────────────────────────────────

const SENTENCE_OPENER_VERBS = new Set([
  "Compare", "Explain", "Describe", "Analyze", "Find", "Show", "List",
  "Tell", "Give", "Check", "Search", "Look", "Help", "What", "How",
  "Why", "Who", "When", "Where", "Is", "Are", "Can", "Could",
  "Should", "Would", "Will", "Do", "Does", "Did",
]);

// ─── Phrase Locking ────────────────────────────────────────

/** Strip punctuation from a token for matching purposes */
function cleanToken(w: string): string {
  return w.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
}

/**
 * Detect locked multi-word phrases from the user's goal.
 * Handles: consecutive capitalized, CamelCase, PascalCase, ALLCAPS,
 * kebab-case, and alias-based detection (works on lowercase input).
 */
function extractLockedPhrases(goal: string): string[] {
  const phrases: string[] = [];
  const words = goal.split(/\s+/);

  // 0. Alias-based detection (works even on all-lowercase input)
  //    Greedy: longest match first, skip matched regions
  //    Uses cleanToken() so "Circle Gateway," or "(Circle Gateway)" still match
  const matchedRegions = new Set<number>();
  for (const aliasKey of ALIAS_KEYS_SORTED) {
    const aliasWords = aliasKey.split(/\s+/);
    if (aliasWords.length < 2) continue;
    for (let i = 0; i <= words.length - aliasWords.length; i++) {
      if (matchedRegions.has(i)) continue;
      let match = true;
      for (let j = 0; j < aliasWords.length; j++) {
        if (cleanToken(words[i + j]) !== aliasWords[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        const phrase = words.slice(i, i + aliasWords.length).join(" ");
        if (!phrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) {
          phrases.push(phrase);
        }
        for (let j = 0; j < aliasWords.length; j++) matchedRegions.add(i + j);
      }
    }
  }
  // 1. CamelCase / PascalCase tokens FIRST (so they don't get extended by consecutive capitalized detection)
  for (let i = 0; i < words.length; i++) {
    if (matchedRegions.has(i)) continue;
    const w = words[i];
    const clean = w.replace(/[^a-zA-Z0-9_-]/g, "");
    if (clean && /[a-z][A-Z]/.test(clean) && clean.length >= 4 && !SENTENCE_OPENER_VERBS.has(clean)) {
      if (!phrases.some((p) => p.includes(clean))) {
        phrases.push(clean);
        matchedRegions.add(i);
      }
    }
  }

  // 2. Consecutive capitalized words (2+ words), extending into meaningful short tokens
  let runStart = -1;
  for (let i = 0; i < words.length; i++) {
    if (matchedRegions.has(i)) { runStart = -1; continue; }
    const w = words[i];
    const isCap = /^[A-Z][a-z]/.test(w) || /^[A-Z]{2,}$/.test(w);
    const isMs = MEANINGFUL_SHORT_TOKENS.has(w.toLowerCase());
    if ((isCap && !SENTENCE_OPENER_VERBS.has(w)) || (isMs && runStart !== -1)) {
      if (runStart === -1 && isCap) runStart = i;
    } else {
      if (runStart !== -1 && i - runStart >= 2) {
        const phrase = words.slice(runStart, i).join(" ");
        if (!phrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) {
          phrases.push(phrase);
        }
      }
      runStart = -1;
    }
  }
  if (runStart !== -1 && words.length - runStart >= 2) {
    const phrase = words.slice(runStart).join(" ");
    if (!phrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) {
      phrases.push(phrase);
    }
  }
  // 3. ALLCAPS compound tokens
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9-]/g, "");
    if (/^[A-Z]{2,}[-]?[0-9]+$/i.test(clean) || /^[A-Z]{3,}$/.test(clean)) {
      if (!phrases.some((p) => p.includes(clean))) {
        phrases.push(clean);
      }
    }
  }

  // 4. kebab-case tokens (erc-8004, x-402)
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9-]/g, "");
    if (/^[a-z]+-[a-z0-9]+$/i.test(clean) && clean.length >= 4) {
      if (!phrases.some((p) => p.includes(clean))) {
        phrases.push(clean);
      }
    }
  }

  return phrases;
}

// ─── Entity Classification ─────────────────────────────────

function classifyEntity(term: string): { type: string; canonical: string } {
  // Strip punctuation but preserve spaces/hyphens for multi-word matching
  const key = term.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const alias = ENTITY_ALIASES[key];
  if (alias) return { type: alias.type, canonical: alias.canonical };
  return { type: "concept", canonical: term };
}

// ─── Boundary-aware required check ─────────────────────────

/**
 * Check if a token appears as a whole word in the goal (not substring).
 * "sol" won't match "solana", "us" won't match "business".
 */
function hasBoundaryMatch(goalLower: string, token: string): boolean {
  // Strip wrapping punctuation so "erc-8004)" matches like "erc-8004"
  const clean = token.replace(/^[^\w]+|[^\w]+$/g, '');
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,;:!?\\.\\(\\)])${escaped}([\\s,;:!?\\.\\(\\)]|$)`, "i").test(goalLower);
}

// ─── Negative Entity Generation ────────────────────────────

function generateNegativeEntities(
  entities: string[],
  topics: string[]
): string[] {
  const negatives: string[] = [];

  if (topics.some((t) => t.includes("crypto"))) {
    negatives.push(
      "price prediction", "market analysis", "trading signal",
      "price forecast", "market cap", "all-time high"
    );
  }

  if (topics.some((t) => t.includes("ai"))) {
    negatives.push("artificial insemination", "ai image generator");
  }

  if (entities.length <= 2) {
    negatives.push("in the news", "breaking news");
  }

  return [...new Set(negatives)];
}

// ─── Scoped Query Expansion ────────────────────────────────

function buildScopedExpandedQueries(
  goal: string,
  requiredEntities: string[],
  topics: string[]
): string[] {
  const queries: string[] = [goal];

  if (requiredEntities.length === 1) {
    // Single entity: "Circle Gateway documentation"
    const e = requiredEntities[0];
    queries.push(`${e} documentation`);
    queries.push(`${e} developer guide`);
  } else if (requiredEntities.length >= 2) {
    // Multiple entities: comparison style
    const joined = requiredEntities.join(" vs ");
    queries.push(`${joined} comparison`);
    queries.push(`${joined} documentation`);
  }

  // Topic variants — only if goal doesn't already contain the topic
  for (const topic of topics.slice(0, 2)) {
    if (!goal.toLowerCase().includes(topic.toLowerCase())) {
      queries.push(`${goal} ${topic}`);
    }
  }

  // Source-type variant — add one domain qualifier
  const domainTerms = ["source", "article", "paper", "data", "report"];
  const lowerGoal = goal.toLowerCase();
  for (const term of domainTerms) {
    if (!lowerGoal.includes(term)) {
      queries.push(`${goal} ${term}`);
      break;
    }
  }

  // NEVER produce queries that drop required entities
  return [...new Set(queries)].slice(0, 7);
}

/**
 * Compute flat entity_terms from structured entities.
 * Shared by deterministic and LLM paths — single source of truth.
 * Priority: primary canonical → primary text → secondary canonical → secondary text.
 */
function computeEntityTerms(
  primaryEntities: Array<{ text: string; canonical: string }>,
  secondaryEntities: Array<{ text: string; canonical: string }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (s: string) => { if (!seen.has(s)) { seen.add(s); result.push(s); } };
  for (const e of primaryEntities) add(e.canonical);
  for (const e of primaryEntities) { if (e.text.toLowerCase() !== e.canonical.toLowerCase()) add(e.text); }
  for (const e of secondaryEntities) add(e.canonical);
  for (const e of secondaryEntities) { if (e.text.toLowerCase() !== e.canonical.toLowerCase()) add(e.text); }
  return result.slice(0, 15);
}

// ─── Canonical Dedup ───────────────────────────────────────

function deduplicateEntities<T extends { canonical: string }>(
  entities: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const e of entities) {
    const key = e.canonical.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }
  return result;
}

// ─── Deterministic Query Builder ───────────────────────────

function runDeterministicQueryBuilder(
  normalizedGoal: string,
  topics: string[]
): {
  expanded_queries: string[];
  entity_terms: string[];
  primary_entities: Array<{ text: string; canonical: string; type: string; required: boolean }>;
  secondary_entities: Array<{ text: string; canonical: string; type: string; required: boolean }>;
  locked_phrases: string[];
  negative_entities: string[];
  negative_filters: string[];
  source_preferences: string[];
} {
  const goal = normalizedGoal.trim().toLowerCase();
  const words = normalizedGoal.split(/\s+/);
  const goalLower = normalizedGoal.toLowerCase();

  // ── Step 1: Extract locked phrases (source of truth) ──
  const lockedPhrases = extractLockedPhrases(normalizedGoal);

  // Track which word indices belong to locked phrases
  const phraseWordIndices = new Set<number>();
  for (const phrase of lockedPhrases) {
    const phraseWords = phrase.split(/\s+/);
    for (let i = 0; i <= words.length - phraseWords.length; i++) {
      let match = true;
      for (let j = 0; j < phraseWords.length; j++) {
        if (cleanToken(words[i + j]) !== cleanToken(phraseWords[j])) {
          match = false;
          break;
        }
      }
      if (match) {
        for (let j = 0; j < phraseWords.length; j++) {
          phraseWordIndices.add(i + j);
        }
      }
    }
  }

  // ── Step 2: Primary entities from locked phrases (always required) ──
  const primaryEntities: Array<{ text: string; canonical: string; type: string; required: boolean }> = [];
  for (const phrase of lockedPhrases) {
    const classified = classifyEntity(phrase);
    primaryEntities.push({
      text: phrase,
      canonical: classified.canonical,
      type: classified.type,
      required: true,
    });
  }

  // ── Step 3: Quoted phrases (required, not already in locked phrases) ──
  const quotedPhrases = normalizedGoal
    .match(/"([^"]+)"/g)
    ?.map((p) => p.replace(/"/g, "")) || [];
  for (const qp of quotedPhrases) {
    const qpl = qp.toLowerCase();
    if (!lockedPhrases.some((lp) => lp.toLowerCase() === qpl)) {
      const classified = classifyEntity(qp);
      primaryEntities.push({
        text: qp,
        canonical: classified.canonical,
        type: classified.type,
        required: true,
      });
    }
  }

  // ── Step 4: Individual tokens from non-phrase regions (optional) ──
  const secondaryEntities: Array<{ text: string; canonical: string; type: string; required: boolean }> = [];

  // Capitalized words (>2 chars, not sentence openers, not inside a phrase)
  for (let i = 0; i < words.length; i++) {
    if (phraseWordIndices.has(i)) continue;
    const w = words[i];
    if (/^[A-Z][A-Za-z0-9_-]+$/.test(w) && w.length > 2) {
      if (SENTENCE_OPENER_VERBS.has(w)) continue;
      const wl = w.toLowerCase();
      if (!primaryEntities.some((pe) => pe.text.toLowerCase().includes(wl))) {
        const classified = classifyEntity(w);
        secondaryEntities.push({
          text: w,
          canonical: classified.canonical,
          type: classified.type,
          required: hasBoundaryMatch(goalLower, wl),
        });
      }
    }
  }

  // Meaningful short tokens from goal (not inside a phrase)
  const goalWords = goal.split(/[^a-z0-9]+/).filter(Boolean);
  for (const gw of goalWords) {
    if (MEANINGFUL_SHORT_TOKENS.has(gw)) {
      const alreadyCovered = [...primaryEntities, ...secondaryEntities].some(
        (e) => e.canonical.toLowerCase() === gw
      );
      if (!alreadyCovered) {
        const classified = classifyEntity(gw);
        secondaryEntities.push({
          text: gw,
          canonical: classified.canonical,
          type: classified.type,
          required: hasBoundaryMatch(goalLower, gw),
        });
      }
    }
  }

  // ── Step 5: Topics as secondary entities (always optional) ──
  for (const t of topics) {
    const tl = t.toLowerCase();
    const alreadyCovered = [...primaryEntities, ...secondaryEntities].some(
      (e) => e.canonical.toLowerCase() === tl
    );
    if (!alreadyCovered && !lockedPhrases.some((lp) => lp.toLowerCase() === tl)) {
      const classified = classifyEntity(t);
      secondaryEntities.push({
        text: t,
        canonical: classified.canonical,
        type: classified.type,
        required: false,
      });
    }
  }

  // ── Step 6: Dedup by canonical ──
  const dedupedPrimary = deduplicateEntities(primaryEntities);
  const dedupedSecondary = deduplicateEntities(
    secondaryEntities.filter(
      (se) => !dedupedPrimary.some((pe) => pe.canonical.toLowerCase() === se.canonical.toLowerCase())
    )
  );

  // ── Step 7: Negative entities (domain-specific) ──
  const allEntities = [...dedupedPrimary, ...dedupedSecondary];
  const negativeEntities = generateNegativeEntities(
    allEntities.filter((e) => e.required).map((e) => e.canonical),
    topics
  );

  // ── Step 8: Scoped query expansion (preserves required entities) ──
  const requiredTerms = dedupedPrimary.map((e) => e.canonical);
  const expandedQueries = buildScopedExpandedQueries(normalizedGoal, requiredTerms, topics);

  // ── Step 9: Negative filters (generic noise) ──
  const negativeFilters: string[] = [];
  if (!goal.includes("ad") && !goal.includes("advertisement")) {
    negativeFilters.push("advertisement", "sponsored");
  }
  if (!goal.includes("paywall")) {
    negativeFilters.push("paywall");
  }

  // ── Step 10: Source preferences ──
  const sourcePreferences: string[] = [];
  if (topics.some((t) => t.includes("research") || t.includes("academic"))) {
    sourcePreferences.push("academic", "peer-reviewed");
  }
  if (topics.some((t) => t.includes("news") || t.includes("current"))) {
    sourcePreferences.push("recent", "verified");
  }
  if (sourcePreferences.length === 0) {
    sourcePreferences.push("credible", "recent");
  }

  // ── Step 11: Computed entity_terms (flat string array for compatibility) ──
  const entityTerms = computeEntityTerms(dedupedPrimary, dedupedSecondary);

  return {
    expanded_queries: expandedQueries,
    entity_terms: entityTerms,
    primary_entities: dedupedPrimary,
    secondary_entities: dedupedSecondary,
    locked_phrases: lockedPhrases,
    negative_entities: negativeEntities,
    negative_filters: negativeFilters,
    source_preferences: sourcePreferences,
  };
}

// ─── Handler ────────────────────────────────────────────────

export const queryBuilderHandler: ServiceHandler = async (
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> => {
  const { normalized_goal, topics, routeTier, brain_query_variants, brain_discovery_strategy, brain_normalized_goal } = input.payload as {
    normalized_goal: string;
    topics: string[];
    routeTier?: DelegatedRouteTier;
    brain_query_variants?: string[];
    brain_discovery_strategy?: string;
    brain_normalized_goal?: string;
  };

  // Merge Brain query variants with deterministic expansion as baseline
  const baseGoal = brain_normalized_goal || normalized_goal || "";
  const det = runDeterministicQueryBuilder(baseGoal, topics || []);
  const brainVariants = (brain_query_variants || []).map((q: string) => q.trim()).filter(Boolean);

  // ── Deterministic mode: Brain variants primary, deterministic second ──
  if (shouldRunServiceAsDeterministic("query_builder")) {
    // Merge Brain query variants first, deterministic second
    const merged = [...brainVariants, ...det.expanded_queries];

    // Dedupe case-insensitively, trim, cap to 7
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const q of merged) {
      const key = q.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.push(q.trim());
      }
    }
    const finalQueries = deduped.slice(0, 7);

    // Derive negative_filters and source_preferences from constraints
    const negativeFilters = [...(det.negative_filters || [])];
    const sourcePreferences = [...(det.source_preferences || [])];
    for (const c of topics || []) {
      const cl = c.toLowerCase();
      if (cl === "recency_priority" && !sourcePreferences.includes("recent")) {
        sourcePreferences.push("recent");
      }
      if (cl === "trust_required" && !sourcePreferences.includes("credible")) {
        sourcePreferences.push("credible", "official");
      }
      if (cl === "free_only" && !negativeFilters.includes("paywall")) {
        negativeFilters.push("paywall", "premium");
      }
      if (cl === "quality_priority" && !sourcePreferences.includes("high_quality")) {
        sourcePreferences.push("high_quality", "primary_source");
      }
    }

    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        primary_entities: det.primary_entities,
        secondary_entities: det.secondary_entities,
        topics: topics || [],
        locked_phrases: det.locked_phrases,
        negative_entities: det.negative_entities,
        entity_terms: det.entity_terms,
        expanded_queries: finalQueries,
        negative_filters: negativeFilters,
        source_preferences: sourcePreferences,
        safe_query_summary: `Built ${finalQueries.length} queries${brainVariants.length > 0 ? ` (${brainVariants.length} from Brain)` : ""}, ${det.primary_entities.length + det.secondary_entities.length} entities, ${negativeFilters.length} filters. Deterministic expansion.`,
      },
      safeSummary: `Built ${finalQueries.length} queries, ${det.primary_entities.length + det.secondary_entities.length} entities, ${negativeFilters.length} filters. Deterministic expansion.`,
      settled: false,
      error: null,
    };
  }

  // ── LLM mode: use Brain variants as primary input, LLM refines/expands ──
  const { generateStructuredJson } = await import("@/lib/paylabs/ai/llm-structured");
  const { toInternalRouteTier } = await import("./helpers");

  const SYSTEM_PROMPT = `=== ROLE ===
You are PayLabs Query Builder. Your task is to analyze a normalized goal and produce structured query expansion output for source discovery.
You do NOT choose final sources. You do NOT invent URLs, titles, prices, wallets, or execute payments.

=== PRESERVE EXACT NAMES ===
Always preserve these exactly as written (no paraphrasing):
project names, protocol names, product names, company names,
URLs/domains, version numbers, technical terms, dates, source names.

=== FIELD RULES ===
primary_entities:
- StructuredEntity[] — extracted from the user's goal.
- Each entity: { text, canonical, type, required }.
- type is one of: protocol, product, company, chain, token, model, standard, contract, client, concept, or other specific type.
- required: true if the entity is essential to the goal (appears as a named subject, not a sentence opener).
- Extract ALL named entities: project names, protocol names, product names, company names, model names, chain names.
- For comparison tasks, BOTH compared entities MUST appear here.

secondary_entities:
- StructuredEntity[] — supporting entities not in primary.
- type/required rules same as primary_entities.
- Include: topic tags, domain terms, or related concepts that refine scope.
- required: true if the entity appears as a whole word boundary match in the goal, false if inferred from topics.

locked_phrases:
- string[] — multi-word phrases from the goal that must NOT be split into individual tokens.
- Examples: "Circle Gateway", "Claude Code", "ERC-8004", "Model Context Protocol".
- Include CamelCase tokens (>=4 chars), consecutive capitalized words (2+), and known alias matches.

negative_entities:
- string[] — terms to EXCLUDE from source discovery to filter noise.
- Domain-specific: for crypto goals, exclude "price prediction", "trading signal", etc.
- For narrow queries (<=2 entities), exclude "in the news", "breaking news".

topics:
- string[] — topic tags from the input. Pass through as-is. Do NOT add topics not in the input.

expanded_queries:
- string[] — 3-7 search query variants for source discovery.
- MUST preserve ALL primary_entities in every query. Never drop required entities.
- Prefer exact-match queries over broad generic queries.
- Include both entities for comparison tasks.
- Add recency wording ONLY if the user explicitly asks for latest/current/recent/today/this week/2025/2026/new.
- No duplicate queries. No generic filler queries.

negative_filters:
- string[] — generic noise filters. Default: ["advertisement", "sponsored", "paywall"].
- Remove "paywall" only if the goal mentions free/open access.

source_preferences:
- string[] — short tags indicating desired source quality.
- Default: ["credible", "recent"].
- Add "academic", "peer-reviewed" for research goals.
- Add "official", "primary_source" for protocol/company documentation goals.

entity_terms:
- string[] — flat deduped list of all entity text and canonical forms (max 15).
- Priority: primary canonical → primary text → secondary canonical → secondary text.
- This is a compatibility field for downstream services.

safe_summary:
- 1 short sentence describing what was built.
- MUST NOT mention internal chain-of-thought, payment internals, wallets, x402, Gateway, or settlement.
- Example: "Built 4 queries for Circle Gateway documentation, 3 entities, 2 filters."

=== FORMAT ===
Return JSON only. No markdown. No commentary. No extra keys. The first character must be "{"`;

  const brainVariantsText = brainVariants.length > 0
    ? `\nBrain query variants (use as primary, refine/expand):\n${brainVariants.map((q: string) => `- "${q}"`).join("\n")}`
    : "";

  const result = await generateStructuredJson<z.infer<typeof QueryBuilderSchema>>({
    agentName: "query_builder",
    routeTier: toInternalRouteTier(routeTier || "easy"),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Goal: "${normalized_goal || ""}"\nTopics: ${JSON.stringify(topics || [])}${brainVariantsText}\nDiscovery strategy: ${brain_discovery_strategy || "none"}\nRoute: ${routeTier || "easy"}`,
    schema: QueryBuilderSchema,
  });

  if (!result.ok) {
    // Fallback: use Brain's LLM-generated variants as primary, deterministic second
    const fallbackMerged = [...brainVariants, ...det.expanded_queries];
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const q of fallbackMerged) {
      const key = q.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        deduped.push(q.trim());
      }
    }
    const fallbackQueries = deduped.slice(0, 7);

    return {
      ok: true,
      serviceName: "query_builder",
      data: {
        primary_entities: det.primary_entities,
        secondary_entities: det.secondary_entities,
        topics: topics || [],
        locked_phrases: det.locked_phrases,
        negative_entities: det.negative_entities,
        entity_terms: det.entity_terms,
        expanded_queries: fallbackQueries,
        negative_filters: det.negative_filters,
        source_preferences: det.source_preferences,
        safe_query_summary: `Built ${fallbackQueries.length} queries (LLM failed, ${brainVariants.length > 0 ? "Brain variants + " : ""}deterministic fallback).`,
      },
      safeSummary: `Built ${fallbackQueries.length} queries (LLM failed, ${brainVariants.length > 0 ? "Brain variants + " : ""}deterministic fallback).`,
      settled: false,
      error: null,
    };
  }

  return {
    ok: true,
    serviceName: "query_builder",
    data: {
      primary_entities: result.data.primary_entities,
      secondary_entities: result.data.secondary_entities,
      topics: result.data.topics,
      locked_phrases: result.data.locked_phrases,
      negative_entities: result.data.negative_entities,
      entity_terms: computeEntityTerms(result.data.primary_entities, result.data.secondary_entities),
      expanded_queries: result.data.expanded_queries,
      negative_filters: result.data.negative_filters,
      source_preferences: result.data.source_preferences,
      safe_query_summary: result.data.safe_summary,
    },
    safeSummary: result.data.safe_summary,
    settled: false,
    error: null,
  };
};
