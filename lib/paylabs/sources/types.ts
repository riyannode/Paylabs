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
  publisher?: string;
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
  matched_primary_entities?: string[];
  matched_secondary_entities?: string[];
  matched_locked_phrases?: string[];
  selection_reason?: string;
}

// ─── Source Context ────────────────────────────────────────
// The user-facing source context block returned in exit_output and resolve API.
export interface SourceContext {
  sources_used: SourceItem[];
  source_selection_summary: string;
  source_confidence: number;
  source_count: number;
  /** How sources were retrieved: live RSSHub, DB fallback, or empty */
  retrieval_mode?: "rsshub_live" | "db_fallback" | "rsshub_live_empty" | "rsshub_empty_tavily_live" | "tavily_live";
  /** Source discovery strategy: topic_routes, catalog, topic_routes_plus_catalog */
  source_strategy?: string;
  /** Number of topic route candidates selected */
  topic_routes_count?: number;
  /** Number of accepted topic route candidates */
  topic_candidates_count?: number;
  /** Topic-aware validation: warns when AI/crypto topic has 0 sources */
  source_validation?: {
    valid: boolean;
    warning?: string;
    detected_topic?: string;
  };
  /** Entity coverage across the selected source set */
  entity_coverage?: { covered: string[]; missing: string[] };
  /** Aspect (requestedAspects) coverage across the selected source set */
  aspect_coverage?: { covered: string[]; missing: string[] };
  /** Overall evidence status derived from coverage + confidence */
  evidence_status?: 'grounded' | 'partially_grounded' | 'insufficient_evidence' | 'synthesis_failed';
  /** Source quality rating based on confidence */
  source_quality?: 'high' | 'medium' | 'low';
  /** Per-source rejection reasons collected during resolution */
  rejection_reasons?: string[];
}


// ─── Retrieval Context ──────────────────────────────────────
// Canonical retrieval context flowing from Query Builder through
// Discovery Planner into locked orchestration and source resolution.
// Authority rules:
//   originalGoal — exact user request, authoritative for entities/aspects/scope
//   normalizedGoal — Intent Planner normalized representation for search/retrieval
//   Brain normalized_goal / query variants — auxiliary search expansion only

type StructuredEntity = {
  text: string;
  canonical: string;
  type: string;
  required: boolean;
};

export type RetrievalContext = {
  /** Exact original user request. Authoritative for entities, aspects, scope. */
  originalGoal: string;
  /** Intent Planner normalized representation. Useful for search/retrieval. */
  normalizedGoal: string;
  /** Intent type hint from Intent Planner. */
  intentType: string;

  /** Required primary entities from Query Builder. */
  primaryEntities: StructuredEntity[];
  /** Contextual secondary entities from Query Builder. */
  secondaryEntities: StructuredEntity[];

  /** Multi-word phrases locked from user goal. */
  lockedPhrases: string[];
  /** Noise patterns to filter out. */
  negativeEntities: string[];
  /** Topic tags for domain-specific filtering. */
  topics: string[];
  /** Aspects the user wants covered. */
  requestedAspects: string[];

  /** Flat entity terms for keyword matching. */
  entityTerms: string[];
  /** Expanded search queries. */
  expandedQueries: string[];
  /** Negative keyword filters. */
  negativeFilters: string[];
  /** Source type preferences. */
  sourcePreferences: string[];
};

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
  // Phase 3A: structured fields from Query Builder (optional for backward compat)
  /** Primary entities — weighted higher in relevance filtering */
  primaryEntities?: Array<{ text: string; canonical: string; type: string; required: boolean }>;
  /** Secondary entities — used as context, lower weight */
  secondaryEntities?: Array<{ text: string; canonical: string; type: string; required: boolean }>;
  /** Negative entities — noise to filter out (e.g. "price prediction", "trading signal") */
  negativeEntities?: string[];
  lockedPhrases?: string[];
  topics?: string[];
  /** Aspects the user wants covered (e.g. "pricing", "api-reference", "getting-started") */
  requestedAspects?: string[];
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
