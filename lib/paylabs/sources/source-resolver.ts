/**
 * Source Resolver
 *
 * Takes ranked candidates from signal_scout and enriches them with
 * full metadata from paylabs_feed_items. Deterministic — no LLM.
 *
 * Safe fields only — NEVER selects source_payload (raw RSS item).
 * Uses whitelist select to guarantee no raw data leaks.
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  SourceItem,
  SourceContext,
  SourceResolverInput,
  SourceResolverOutput,
} from "./types";

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

  const topCandidates = rankedCandidates.slice(0, maxSources);

  // Split: inline live candidates vs DB candidates
  const liveCandidates: typeof topCandidates = [];
  const dbCandidateIds: string[] = [];

  for (const c of topCandidates) {
    const ext = c as Record<string, unknown>;
    if (ext.source_kind === "rsshub_live" || ext.source_kind === "tavily_live") {
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
function filterByRelevance(sources: SourceItem[], normalizedGoal: string): SourceItem[] {
  if (sources.length === 0) return sources;

  const goalLower = normalizedGoal.toLowerCase();
  const terms = goalLower.split(/\s+/).filter((w) => w.length > 2);

  // Extract entity patterns (owner/repo, product names)
  const ownerRepoMatch = goalLower.match(/(\w[\w-]*)\s*\/\s*(\w[\w-]*)/);
  const entityTerms: string[] = [];
  if (ownerRepoMatch) {
    entityTerms.push(ownerRepoMatch[1].toLowerCase());
    entityTerms.push(ownerRepoMatch[2].toLowerCase());
  }

  // Domain-specific intent
  const isGitHubIntent = goalLower.includes("github") || goalLower.includes("repo") || !!ownerRepoMatch;
  const isNewsIntent = goalLower.includes("news") || goalLower.includes("latest") || goalLower.includes("update");

  const filtered = sources.filter((src) => {
    const title = (src.title || "").toLowerCase();
    const summary = (src.summary || "").toLowerCase();
    const domain = (src.domain || "").toLowerCase();
    const routePath = (src.route_path || "").toLowerCase();
    const url = (src.url || "").toLowerCase();
    const combined = `${title} ${summary} ${domain} ${routePath} ${url}`;

    // Entity terms: at least ONE must appear
    if (entityTerms.length > 0) {
      const hasEntity = entityTerms.some((et) => combined.includes(et));
      if (!hasEntity) return false;
    }

    // GitHub intent: must be from github.com or have repo-related content
    if (isGitHubIntent) {
      const isGitHubDomain = domain.includes("github.com") || domain.includes("github.");
      const hasRepoContent = combined.includes("commit") || combined.includes("pull request") ||
        combined.includes("repository") || combined.includes("release") || combined.includes("merge") ||
        combined.includes("issue") || combined.includes("branch") || combined.includes("fork");
      if (!isGitHubDomain && !hasRepoContent) return false;
    }

    // General keyword match: at least ONE query term must appear
    if (terms.length > 0 && !isGitHubIntent) {
      const hasKeyword = terms.some((t) => combined.includes(t));
      if (!hasKeyword) return false;
    }

    return true;
  });

  return filtered;
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
    const sources = filterByRelevance(rawSources, input.normalizedGoal);
    const sourceConfidence = computeSourceConfidence(sources);
    const sourceSelectionSummary = buildSelectionSummary(
      sources,
      input.normalizedGoal,
      input.intentType
    );

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
