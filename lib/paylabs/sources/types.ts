/**
 * Source Discovery Types
 *
 * Types for the RSSHub source discovery MVP.
 * Safe metadata only — no raw RSS payloads, no x402 data, no secrets.
 */

// ─── Enriched Source Item ──────────────────────────────────
// The safe metadata returned to users/AI for a single source.
export interface SourceItem {
  feed_item_id: string;
  title: string;
  url: string;
  domain: string | null;
  summary: string;
  author: string;
  published_at: string | null;
  route_path: string | null;
  trust_status: string;
  claim_status: string;
  rank: number;
  relevance_score: number;
  source_kind?: "rsshub_live" | "tavily_live" | "db_feed_item";
  provider?: "rsshub" | "tavily" | "supabase";
  rsshub_feed_url?: string | null;
  docs_url?: string | null;
  reason?: string;
}

// ─── Source Context ────────────────────────────────────────
// The user-facing source context block returned in exit_output and resolve API.
export interface SourceContext {
  sources_used: SourceItem[];
  source_selection_summary: string;
  source_confidence: number;
  source_count: number;
  /** How sources were retrieved: live RSSHub, DB fallback, or empty */
  retrieval_mode?: "rsshub_live" | "db_fallback" | "rsshub_live_empty";
  /** Source discovery strategy: topic_routes, catalog, topic_routes_plus_catalog */
  source_strategy?: string;
  /** Number of topic route candidates selected */
  topic_routes_count?: number;
  /** Number of accepted topic route candidates */
  topic_candidates_count?: number;
}

// ─── Source Resolver Input ─────────────────────────────────
export interface SourceResolverInput {
  /** Ranked candidates from signal_scout (feed_item_id + rank + relevance_score) */
  rankedCandidates: Array<{
    feed_item_id: string;
    rank: number;
    relevance_score: number;
  }>;
  /** Brain's normalized goal (from intent_planner via discovery_planner) */
  normalizedGoal: string;
  /** Brain's intent type hint */
  intentType?: string;
  /** Brain's constraints */
  constraints?: string[];
  /** Entity terms for relevance filtering (x402, ai, usdc, etc.) */
  entityTerms?: string[];
  /** Max sources to return (default 10) */
  maxSources?: number;
}

// ─── Source Resolver Output ────────────────────────────────
export interface SourceResolverOutput {
  ok: boolean;
  sourceContext: SourceContext;
  error: string | null;
}

// ─── Resolve API Request ───────────────────────────────────
export interface ResolveSourceRequest {
  /** User query to match against sources */
  query: string;
  /** Optional intent type filter */
  intent_type?: string;
  /** Optional trust status filter */
  trust_status?: string;
  /** Optional claim status filter */
  claim_status?: string;
  /** Max results (default 10) */
  limit?: number;
}
