/**
 * Source Resolution Diagnostic — traces live RSSHub items through the pipeline.
 *
 * Persists to: agent_trace.source_resolution_diagnostic
 * Purpose: find exactly WHERE live RSSHub items disappear at runtime.
 *
 * No raw RSS XML/JSON. No secrets. No raw payment data.
 */

// ─── Diagnostic Scenario ──────────────────────────────────

export type DiagnosticScenario =
  | "A_RANKED_CANDIDATES_EMPTY"
  | "B_RESOLVER_FILTERED_ALL"
  | "C_RESOLVER_THROW"
  | "D_RESPONSE_OR_PERSISTENCE_LOSS"
  | "OK_SOURCES_FOUND";

// ─── Diagnostic Record ────────────────────────────────────

export interface SourceResolutionDiagnostic {
  /** Timestamp of diagnostic collection */
  collected_at: string;

  // ── Phase 0: RSSHub config ──
  rsshub_base_url_used: string | null;
  detected_topic: string | null;
  topic_routes_attempted: number;
  topic_routes_success_count: number;

  // ── Phase 1: Live fetch ──
  live_items_fetched_count: number;
  live_items_after_validation_count: number;

  // ── Phase 2: signal_scout output ──
  signal_scout_ranked_candidates_count: number;

  // ── Phase 3: discovery_planner (macro-node) output ──
  discovery_planner_ranked_candidates_count: number;

  // ── Phase 4: locked-orchestration extraction ──
  locked_orchestration_ranked_candidates_count: number;
  ranked_candidates_have_url_count: number;
  ranked_candidates_have_feed_item_id_count: number;

  // ── Phase 5: query_builder output ──
  entity_terms_count: number;
  expanded_queries: string[];
  retrieval_mode: string | null;

  // ── Phase 6: resolveSources ──
  resolve_sources_called: boolean;
  resolve_sources_ok: boolean | null;
  resolve_sources_error_safe: string | null;
  resolver_sources_used_count: number;
  filter_rejection_reason_counts?: Record<string, number>;

  // ── Phase 7: final ──
  final_source_context_count: number;
  scenario: DiagnosticScenario;

  // ── Triage hints ──
  notes: string[];
}

// ─── Builder ──────────────────────────────────────────────

export function createSourceResolutionDiagnostic(): SourceResolutionDiagnostic {
  return {
    collected_at: new Date().toISOString(),
    rsshub_base_url_used: process.env.PAYLABS_RSSHUB_BASE_URL || null,
    detected_topic: null,
    topic_routes_attempted: 0,
    topic_routes_success_count: 0,
    live_items_fetched_count: 0,
    live_items_after_validation_count: 0,
    signal_scout_ranked_candidates_count: 0,
    discovery_planner_ranked_candidates_count: 0,
    locked_orchestration_ranked_candidates_count: 0,
    ranked_candidates_have_url_count: 0,
    ranked_candidates_have_feed_item_id_count: 0,
    entity_terms_count: 0,
    expanded_queries: [],
    retrieval_mode: null,
    resolve_sources_called: false,
    resolve_sources_ok: null,
    resolve_sources_error_safe: null,
    resolver_sources_used_count: 0,
    filter_rejection_reason_counts: undefined,
    final_source_context_count: 0,
    scenario: "A_RANKED_CANDIDATES_EMPTY",
    notes: [],
  };
}

// ─── Scenario Resolution ──────────────────────────────────

export function resolveDiagnosticScenario(
  diag: SourceResolutionDiagnostic,
): DiagnosticScenario {
  // Phase 1: Did live fetch produce anything?
  if (diag.live_items_fetched_count === 0) {
    diag.notes.push("RSSHub returned 0 live items — check RSSHub endpoint availability or topic route matching.");
    return "A_RANKED_CANDIDATES_EMPTY";
  }

  // Phase 2: Did signal_scout produce ranked candidates?
  if (diag.signal_scout_ranked_candidates_count === 0) {
    diag.notes.push(
      `Live items fetched (${diag.live_items_fetched_count}) but signal_scout ranked 0. ` +
      "Bug is in signal_scout scoring/acceptance gate or domain guards."
    );
    return "A_RANKED_CANDIDATES_EMPTY";
  }

  // Phase 3: Did discovery_planner output carry candidates?
  if (diag.discovery_planner_ranked_candidates_count === 0) {
    diag.notes.push(
      `signal_scout produced ${diag.signal_scout_ranked_candidates_count} candidates ` +
      "but discovery_planner output has 0. Bug is in processSignalResult extraction or graph state."
    );
    return "A_RANKED_CANDIDATES_EMPTY";
  }

  // Phase 4: Did locked-orchestration extract candidates?
  if (diag.locked_orchestration_ranked_candidates_count === 0) {
    diag.notes.push(
      `discovery_planner output has ${diag.discovery_planner_ranked_candidates_count} candidates ` +
      "but locked-orchestration extracted 0. Bug is in data-shape extraction from macro-node response."
    );
    return "A_RANKED_CANDIDATES_EMPTY";
  }

  // Phase 5: Did resolveSources run?
  if (!diag.resolve_sources_called) {
    diag.notes.push("resolveSources was never called — rankedCandidates.length check may have failed.");
    return "D_RESPONSE_OR_PERSISTENCE_LOSS";
  }

  // Phase 6: Did resolveSources succeed?
  if (diag.resolve_sources_ok === false) {
    diag.notes.push(`resolveSources threw: ${diag.resolve_sources_error_safe || "unknown"}`);
    return "C_RESOLVER_THROW";
  }

  // Phase 7: Did resolver produce sources?
  if (diag.resolver_sources_used_count === 0) {
    diag.notes.push(
      `resolveSources returned ok but sources_used=0 with ${diag.locked_orchestration_ranked_candidates_count} candidates. ` +
      "Bug is in filterByRelevance or enrichRankedCandidates."
    );
    return "B_RESOLVER_FILTERED_ALL";
  }

  // Phase 8: Did sourceContext make it to final output?
  if (diag.final_source_context_count === 0) {
    diag.notes.push("resolveSources produced sources but final sourceContext has 0. Bug is in response passthrough.");
    return "D_RESPONSE_OR_PERSISTENCE_LOSS";
  }

  diag.notes.push(`OK: ${diag.final_source_context_count} sources resolved and persisted.`);
  return "OK_SOURCES_FOUND";
}
