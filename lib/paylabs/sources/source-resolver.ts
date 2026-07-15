/**
 * Source Resolver
 *
 * Takes ranked candidates from signal_scout and enriches them with
 * full metadata from paylabs_feed_items. Deterministic — no LLM.
 *
 * Safe fields only — NEVER selects source_payload (raw RSS item).
 * Uses whitelist select to guarantee no raw data leaks.
 */

import { supabaseAdmin } from "@/lib/paylabs/db/server";
import type {
  SourceItem,
  SourceContext,
  SourceResolverInput,
  SourceResolverOutput,
} from "./types";
import { sanitizeEntityTerms, hasBoundaryTerm } from "./source-term-matching";
import { detectTopics } from "@/lib/paylabs/rsshub/topic-routes";
import {
  isGenericCatchAllSource,
} from "@/lib/paylabs/rsshub/topic-source-guards";

// ─── Topic-aware source validation ────────────────────────

/** Check if a topic query has insufficient sources — frontend must NOT show ✅ */
function validateTopicSources(
  sources: SourceItem[],
  normalizedGoal: string,
  entityTerms: string[]
): { valid: boolean; warning?: string; detected_topic?: string } {
  const topics = detectTopics(normalizedGoal, entityTerms);
  if (topics.length === 0) return { valid: true };

  const hasAi = topics.some((t) => t.category === "ai");
  const hasCrypto = topics.some((t) => t.category === "crypto");

  if (hasAi && sources.length === 0) {
    return {
      valid: false,
      warning: "AI topic detected but no AI-specific sources found. Links are empty — do not mark as ✅.",
      detected_topic: "ai",
    };
  }
  if (hasCrypto && sources.length === 0) {
    return {
      valid: false,
      warning: "Crypto topic detected but no crypto-specific sources found. Links are empty — do not mark as ✅.",
      detected_topic: "crypto",
    };
  }
  return { valid: true };
}

// ─── Whitelist: safe columns only ─────────────────────────
// NEVER include source_payload, normalized_sha256, content_sha256,
// creator_wallet, price_per_citation_usdc, price_per_unlock_usdc
const SAFE_FEED_ITEM_COLUMNS =
  "id, canonical_url, title, summary, author_name, publisher, published_at, domain, trust_status, claim_status, tags, rsshub_route_id";

// ─── Enrich ranked candidates into SourceItems ────────────

async function enrichRankedCandidates(
  rankedCandidates: SourceResolverInput["rankedCandidates"],
  maxSources: number
): Promise<SourceItem[]> {
  if (rankedCandidates.length === 0) return [];

  // Relevance must run before the final maxSources cut; otherwise upstream topic
  // ordering can discard a lower-ranked exact entity match before resolver scoring.
  const topCandidates = rankedCandidates.slice(0, Math.max(maxSources, 100));

  // Split: inline live candidates vs DB candidates
  const liveCandidates: typeof topCandidates = [];
  const dbCandidateIds: string[] = [];

  for (const c of topCandidates) {
    const ext = c as Record<string, unknown>;
    if (ext.source_kind === "rsshub_live" || ext.source_kind === "tavily_live" || ext.source_kind === "jina_live") {
      liveCandidates.push(c);
    } else {
      dbCandidateIds.push(c.feed_item_id);
    }
  }

  const enriched: SourceItem[] = [];

  // ── Inline live candidates: build SourceItem directly ──
  for (const candidate of liveCandidates) {
    const ext = candidate as Record<string, unknown>;
    const sourceUrl = String(ext.source_url || "");
    if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) continue;

    let domain: string | null = typeof ext.domain === "string" ? ext.domain : null;
    if (!domain) {
      try { domain = new URL(sourceUrl).hostname; } catch { domain = null; }
    }

    enriched.push({
      feed_item_id: candidate.feed_item_id,
      title: String(ext.title || "(untitled)"),
      url: sourceUrl,
      domain,
      summary: String(ext.summary || "").slice(0, 500),
      author: String(ext.author || ""),
      published_at: ext.published_at ? String(ext.published_at) : null,
      route_path: typeof ext.route_path === "string" ? ext.route_path : null,
      trust_status: ext.source_kind === "rsshub_live" ? "rsshub_live" : "web_fallback",
      claim_status: "unclaimed",
      rank: candidate.rank,
      relevance_score: candidate.relevance_score,
      source_kind: ext.source_kind as SourceItem["source_kind"],
      provider: ext.provider as SourceItem["provider"],
      rsshub_feed_url: ext.rsshub_feed_url ? String(ext.rsshub_feed_url) : null,
      docs_url: ext.docs_url ? String(ext.docs_url) : null,
      reason: typeof ext.reason === "string" ? ext.reason : undefined,
    });
  }

  // ── DB candidates: existing enrichment ──
  if (dbCandidateIds.length > 0) {
    const { data: items, error } = await supabaseAdmin()
      .from("paylabs_feed_items")
      .select(SAFE_FEED_ITEM_COLUMNS)
      .in("id", dbCandidateIds)
      .eq("is_active", true);

    if (!error && items) {
      const itemMap = new Map(items.map((item) => [item.id, item]));

      for (const candidate of topCandidates.filter((c) => dbCandidateIds.includes(c.feed_item_id))) {
        const item = itemMap.get(candidate.feed_item_id);
        if (!item) continue;

        let domain = item.domain as string | null;
        if (!domain && item.canonical_url) {
          try { domain = new URL(item.canonical_url).hostname; } catch { domain = null; }
        }

        let routePath: string | null = null;
        if (item.rsshub_route_id) {
          const { data: route } = await supabaseAdmin()
            .from("paylabs_rsshub_routes")
            .select("route_path")
            .eq("id", item.rsshub_route_id)
            .single();
          routePath = (route?.route_path as string) ?? null;
        }

        enriched.push({
          feed_item_id: String(item.id),
          title: String(item.title || "(untitled)"),
          url: String(item.canonical_url || ""),
          domain,
          summary: String(item.summary || "").slice(0, 500),
          author: String(item.author_name || item.publisher || ""),
          published_at: (item.published_at as string) ?? null,
          route_path: routePath,
          trust_status: String(item.trust_status || "unverified"),
          claim_status: String(item.claim_status || "unclaimed"),
          rank: candidate.rank,
          relevance_score: candidate.relevance_score,
          source_kind: "db_feed_item",
          provider: "supabase",
        });
      }
    }
  }

  // Sort by rank
  enriched.sort((a, b) => a.rank - b.rank);

  return enriched;
}

// ─── Compute aggregate confidence ─────────────────────────

function computeSourceConfidence(sources: SourceItem[]): number {
  if (sources.length === 0) return 0;

  let totalScore = 0;
  for (const src of sources) {
    let itemScore = src.relevance_score;

    // Trust status bonus
    if (src.trust_status === "verified") itemScore += 0.1;
    else if (src.trust_status === "suspicious") itemScore -= 0.2;

    // Claim status bonus
    if (src.claim_status === "claimed") itemScore += 0.05;

    totalScore += Math.max(0, Math.min(1, itemScore));
  }

  return Math.round((totalScore / sources.length) * 100) / 100;
}

// ─── Build selection summary ──────────────────────────────

function buildSelectionSummary(
  sources: SourceItem[],
  normalizedGoal: string,
  intentType?: string
): string {
  if (sources.length === 0) return "No sources found.";

  const domains = [...new Set(sources.map((s) => s.domain).filter(Boolean))];
  const verified = sources.filter((s) => s.trust_status === "verified").length;
  const claimed = sources.filter((s) => s.claim_status === "claimed").length;

  const parts = [
    `${sources.length} sources ranked by relevance`,
    intentType ? `for ${intentType}` : "",
    domains.length > 0 ? `across ${domains.length} domain(s)` : "",
    verified > 0 ? `${verified} verified` : "",
    claimed > 0 ? `${claimed} claimed` : "",
  ].filter(Boolean);

  return parts.join(", ") + ".";
}

// ─── Relevance filter: reject sources that don't match the query ───

/** Check if a domain string is exactly baseDomain or a subdomain of it */
function isDomainOrSubdomain(input: string, baseDomain: string): boolean {
  const raw = (input || "").trim().toLowerCase();
  if (!raw) return false;
  const normalizedBase = baseDomain.toLowerCase();
  let hostname = raw;
  try {
    hostname = raw.includes("://") ? new URL(raw).hostname.toLowerCase() : raw;
  } catch {
    // keep raw as hostname candidate
  }
  hostname = hostname.split(":")[0];
  return hostname === normalizedBase || hostname.endsWith(`.${normalizedBase}`);
}

/* escapeRegexLocal removed — now using shared hasBoundaryTerm from source-term-matching */

/* hasTerm now uses shared hasBoundaryTerm from source-term-matching */

const FINAL_RELEVANCE_THRESHOLD = 0.35;
const QUERY_STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "how", "this", "that", "with",
  "from", "into", "about", "between", "after", "before", "the", "and", "for",
  "repository", "releases", "latest", "recent", "updates", "update", "news",
]);

export interface SourceRelevanceEvaluation {
  accepted: boolean;
  score: number;
  reason: "accepted" | "negative_entity" | "generic_catch_all" | "wrong_repository" | "github_intent_mismatch" | "keyword_mismatch" | "below_threshold";
  matchPriority: number;
  matchReason: "primary_exact_title" | "primary_exact_summary" | "primary_alias_title" | "primary_alias_summary" | "entity_title" | "entity_summary" | "topic_only_penalty" | "keyword_match";
}

export function evaluateSourceRelevance(
  source: SourceItem,
  normalizedGoal: string,
  entityTerms: string[] = [],
  primaryEntities: Array<{ text: string; canonical: string; type: string; required: boolean }> = [],
  negativeEntities: string[] = [],
): SourceRelevanceEvaluation {
  const goalLower = normalizedGoal.toLowerCase();
  const title = (source.title || "").toLowerCase();
  const summary = (source.summary || "").toLowerCase();
  const domain = (source.domain || "").toLowerCase();
  const routePath = (source.route_path || "").toLowerCase();
  const url = (source.url || "").toLowerCase();
  const reason = (source.reason || "").toLowerCase();
  const combined = `${title} ${summary} ${domain} ${routePath} ${url} ${reason}`;
  const detectedTopics = detectTopics(normalizedGoal, entityTerms);
  const queryHasDomainTopic = detectedTopics.some((topic) => topic.category === "ai" || topic.category === "crypto");

  const negativePatterns = sanitizeEntityTerms(negativeEntities).map((term) => term.toLowerCase());
  if (negativePatterns.some((term) => hasBoundaryTerm(combined, term))) {
    return { accepted: false, score: 0, reason: "negative_entity", matchPriority: 0, matchReason: "topic_only_penalty" };
  }
  if (queryHasDomainTopic && isGenericCatchAllSource({ domain, routePath, url })) {
    return { accepted: false, score: 0, reason: "generic_catch_all", matchPriority: 0, matchReason: "topic_only_penalty" };
  }

  const ownerRepoMatch = goalLower.match(/(\w[\w-]*)\s*\/\s*(\w[\w-]*)/);
  const isGitHubIntent = /\bgithub\b/i.test(goalLower) || /\brepo(s|sitory|sitories)?\b/i.test(goalLower) || !!ownerRepoMatch;
  let intendedRepositoryMatch = false;
  if (ownerRepoMatch) {
    const ownerMatches = hasBoundaryTerm(combined, ownerRepoMatch[1]);
    const repoMatches = hasBoundaryTerm(combined, ownerRepoMatch[2]);
    if (!ownerMatches || !repoMatches) {
      return { accepted: false, score: 0, reason: "wrong_repository", matchPriority: 0, matchReason: "topic_only_penalty" };
    }
    intendedRepositoryMatch = true;
  } else if (isGitHubIntent) {
    const isGitHubDomain = isDomainOrSubdomain(domain, "github.com");
    const hasRepoContent = /\b(commit|pull request|repository|release|merge|issue|branch|fork)\b/i.test(combined);
    if (!isGitHubDomain && !hasRepoContent) {
      return { accepted: false, score: 0, reason: "github_intent_mismatch", matchPriority: 0, matchReason: "topic_only_penalty" };
    }
  }

  const sanitizedEntities = sanitizeEntityTerms(entityTerms).map((term) => term.toLowerCase());
  const primaryDefinitions = primaryEntities.length > 0
    ? primaryEntities.map((entity) => ({
        canonical: entity.canonical.trim().toLowerCase(),
        alias: entity.text.trim().toLowerCase(),
      })).filter((entity) => entity.canonical || entity.alias)
    : sanitizedEntities.slice(0, 1).map((canonical) => ({ canonical, alias: canonical }));
  const primaryTerms = new Set(primaryDefinitions.flatMap((entity) => [entity.canonical, entity.alias]).filter(Boolean));
  const secondaryTerms = sanitizedEntities.filter((term) => !primaryTerms.has(term));

  let score = Math.max(0, Math.min(1, Number(source.relevance_score) || 0));
  let matchPriority = 0;
  let matchReason: SourceRelevanceEvaluation["matchReason"] = "keyword_match";
  let missingPrimaryEntity = false;

  if (intendedRepositoryMatch) {
    score += 0.50;
    matchPriority = 4;
    matchReason = "entity_title";
  }

  const exactTitle = primaryDefinitions.some((entity) => entity.canonical && hasBoundaryTerm(title, entity.canonical));
  const exactSummary = primaryDefinitions.some((entity) => entity.canonical && hasBoundaryTerm(summary, entity.canonical));
  const aliasTitle = primaryDefinitions.some((entity) => entity.alias && entity.alias !== entity.canonical && hasBoundaryTerm(title, entity.alias));
  const aliasSummary = primaryDefinitions.some((entity) => entity.alias && entity.alias !== entity.canonical && hasBoundaryTerm(summary, entity.alias));

  if (exactTitle) {
    score += 0.35;
    matchPriority = 4;
    matchReason = "primary_exact_title";
  } else if (exactSummary) {
    score += 0.22;
    matchPriority = 3;
    matchReason = "primary_exact_summary";
  } else if (aliasTitle) {
    score += 0.24;
    matchPriority = 3;
    matchReason = "primary_alias_title";
  } else if (aliasSummary) {
    score += 0.14;
    matchPriority = 2;
    matchReason = "primary_alias_summary";
  } else if (primaryDefinitions.length > 0 && !intendedRepositoryMatch) {
    score -= 0.65;
    missingPrimaryEntity = true;
    matchReason = "topic_only_penalty";
  }

  const entityTitleMatch = secondaryTerms.some((term) => hasBoundaryTerm(title, term));
  const entitySummaryMatch = secondaryTerms.some((term) => hasBoundaryTerm(summary, term));
  if (entityTitleMatch) {
    score += 0.14;
    matchPriority = Math.max(matchPriority, 2);
    if (matchReason === "keyword_match") matchReason = "entity_title";
  } else if (entitySummaryMatch) {
    score += 0.07;
    matchPriority = Math.max(matchPriority, 1);
    if (matchReason === "keyword_match") matchReason = "entity_summary";
  }

  const queryTerms = [...new Set(goalLower.split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !QUERY_STOPWORDS.has(term)))];
  const titleKeywordMatches = queryTerms.filter((term) => hasBoundaryTerm(title, term)).length;
  const summaryKeywordMatches = queryTerms.filter((term) => hasBoundaryTerm(summary, term)).length;
  score += Math.min(0.12, titleKeywordMatches * 0.04);
  score += Math.min(0.06, summaryKeywordMatches * 0.02);
  if (missingPrimaryEntity) score = Math.min(score, FINAL_RELEVANCE_THRESHOLD - 0.01);
  score = Math.max(0, Math.min(1, score));

  if (primaryDefinitions.length === 0 && !isGitHubIntent && queryTerms.length > 0 && titleKeywordMatches + summaryKeywordMatches === 0) {
    return { accepted: false, score, reason: "keyword_mismatch", matchPriority, matchReason };
  }
  if (score < FINAL_RELEVANCE_THRESHOLD) {
    return { accepted: false, score, reason: "below_threshold", matchPriority, matchReason };
  }
  return { accepted: true, score, reason: "accepted", matchPriority, matchReason };
}

export function filterByRelevance(
  sources: SourceItem[],
  normalizedGoal: string,
  entityTerms?: string[],
  primaryEntities?: Array<{ text: string; canonical: string; type: string; required: boolean }>,
  negativeEntities?: string[],
): SourceItem[] {
  const evaluated = sources.map((source) => ({
    source: { ...source },
    evaluation: evaluateSourceRelevance(
      source,
      normalizedGoal,
      entityTerms || [],
      primaryEntities || [],
      negativeEntities || [],
    ),
  })).filter((entry) => entry.evaluation.accepted);

  for (const entry of evaluated) {
    entry.source.relevance_score = entry.evaluation.score;
    entry.source.reason = `${entry.source.reason ? `${entry.source.reason};` : ""}relevance:${entry.evaluation.matchReason}`;
  }

  evaluated.sort((a, b) => {
    if (b.evaluation.matchPriority !== a.evaluation.matchPriority) {
      return b.evaluation.matchPriority - a.evaluation.matchPriority;
    }
    if (b.source.relevance_score !== a.source.relevance_score) {
      return b.source.relevance_score - a.source.relevance_score;
    }
    if (a.source.rank !== b.source.rank) return a.source.rank - b.source.rank;
    return a.source.url.localeCompare(b.source.url);
  });

  return evaluated.map((entry, index) => ({ ...entry.source, rank: index + 1 }));
}

// ─── Public API ───────────────────────────────────────────

/**
 * Resolve ranked candidates into enriched source context.
 * Called by the orchestrator after signal_scout completes.
 */
export async function resolveSources(
  input: SourceResolverInput
): Promise<SourceResolverOutput> {
  const maxSources = input.maxSources ?? 10;

  try {
    const rawSources = await enrichRankedCandidates(input.rankedCandidates, maxSources);
    // Apply relevance filter: reject sources that don't match the query
    // Pass entity_terms so short meaningful tokens (x402, ai, usdc) are used in matching
    const rawEntityCount = (input.entityTerms || []).length;
    const sources = filterByRelevance(
      rawSources,
      input.normalizedGoal,
      input.entityTerms,
      input.primaryEntities,
      input.negativeEntities,
    ).slice(0, maxSources);
    const sanitizedEntityCount = sanitizeEntityTerms(input.entityTerms || []).length;
    const sourceConfidence = computeSourceConfidence(sources);
    // Safe diagnostic: entity term counts (no raw secrets)
    const entityDiagnostic = rawEntityCount > 0
      ? ` entity_terms_raw_count=${rawEntityCount} entity_terms_sanitized_count=${sanitizedEntityCount}`
      : "";
    const sourceSelectionSummary = buildSelectionSummary(
      sources,
      input.normalizedGoal,
      input.intentType
    ) + entityDiagnostic;

    // Topic-aware validation: warn if AI/crypto topic but 0 sources
    const sourceValidation = validateTopicSources(sources, input.normalizedGoal, input.entityTerms || []);

    return {
      ok: true,
      sourceContext: {
        sources_used: sources,
        source_selection_summary: sourceSelectionSummary,
        source_confidence: sourceConfidence,
        source_count: sources.length,
        source_validation: sourceValidation,
      },
      error: null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      sourceContext: {
        sources_used: [],
        source_selection_summary: `Source resolution failed: ${msg}`,
        source_confidence: 0,
        source_count: 0,
      },
      error: msg,
    };
  }
}

/**
 * Standalone source resolution: query-based search without orchestrator.
 * Used by /api/paylabs/sources/resolve endpoint.
 */
export async function resolveSourcesByQuery(
  query: string,
  options?: {
    intentType?: string;
    trustStatus?: string;
    claimStatus?: string;
    limit?: number;
  }
): Promise<SourceResolverOutput> {
  const limit = options?.limit ?? 10;

  try {
    // Build Supabase query — safe columns only
    let dbQuery = supabaseAdmin()
      .from("paylabs_feed_items")
      .select(SAFE_FEED_ITEM_COLUMNS)
      .eq("is_active", true);

    // Optional filters
    if (options?.trustStatus) {
      dbQuery = dbQuery.eq("trust_status", options.trustStatus);
    }
    if (options?.claimStatus) {
      dbQuery = dbQuery.eq("claim_status", options.claimStatus);
    }

    // Text search: title OR summary OR author_name
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (terms.length > 0) {
      // Build OR filters across title, summary, author_name
      const orParts: string[] = [];
      for (const t of terms) {
        orParts.push(`title.ilike.%${t}%`);
        orParts.push(`summary.ilike.%${t}%`);
        orParts.push(`author_name.ilike.%${t}%`);
      }
      dbQuery = dbQuery.or(orParts.join(","));
    }

    dbQuery = dbQuery
      .order("published_at", { ascending: false })
      .limit(limit * 2); // fetch extra for scoring

    const { data: items, error } = await dbQuery;
    if (error || !items) {
      return {
        ok: false,
        sourceContext: {
          sources_used: [],
          source_selection_summary: `Query failed: ${error?.message || "no data"}`,
          source_confidence: 0,
          source_count: 0,
        },
        error: error?.message || "no data",
      };
    }

    // Score items by keyword relevance (same logic as signal_scout deterministic)
    const scored = items.map((item) => {
      let score = 0;
      const title = String(item.title || "").toLowerCase();
      const summary = String(item.summary || "").toLowerCase();

      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (summary.includes(term)) score += 1;
      }

      // Recency bonus
      const publishedAt = item.published_at
        ? new Date(item.published_at as string).getTime()
        : 0;
      if (publishedAt > 0) {
        const ageHours = (Date.now() - publishedAt) / (1000 * 60 * 60);
        if (ageHours < 24) score += 3;
        else if (ageHours < 72) score += 2;
        else if (ageHours < 168) score += 1;
      }

      return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const maxScore = Math.max(scored[0]?.score || 1, 1);

    const sources: SourceItem[] = scored.slice(0, limit).map((entry, i) => {
      let domain: string | null = entry.item.domain as string | null;
      if (!domain && entry.item.canonical_url) {
        try {
          domain = new URL(entry.item.canonical_url as string).hostname;
        } catch {
          domain = null;
        }
      }

      return {
        feed_item_id: String(entry.item.id),
        title: String(entry.item.title || "(untitled)"),
        url: String(entry.item.canonical_url || ""),
        domain,
        summary: String(entry.item.summary || "").slice(0, 500),
        author: String(entry.item.author_name || entry.item.publisher || ""),
        published_at: (entry.item.published_at as string) ?? null,
        route_path: null,
        trust_status: String(entry.item.trust_status || "unverified"),
        claim_status: String(entry.item.claim_status || "unclaimed"),
        rank: i + 1,
        relevance_score: Math.min(entry.score / maxScore, 1),
      };
    });

    const sourceConfidence = computeSourceConfidence(sources);
    const sourceSelectionSummary = buildSelectionSummary(sources, query, options?.intentType);

    return {
      ok: true,
      sourceContext: {
        sources_used: sources,
        source_selection_summary: sourceSelectionSummary,
        source_confidence: sourceConfidence,
        source_count: sources.length,
      },
      error: null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      sourceContext: {
        sources_used: [],
        source_selection_summary: `Source resolution failed: ${msg}`,
        source_confidence: 0,
        source_count: 0,
      },
      error: msg,
    };
  }
}
