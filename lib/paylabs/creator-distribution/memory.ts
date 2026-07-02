/**
 * Creator Distribution Memory
 *
 * Safe memory for evaluator and creator tracking.
 * Stores summaries and metadata, NEVER raw chain-of-thought,
 * raw signatures, secrets, or private keys.
 */

import { supabaseAdmin } from "@/lib/paylabs/db/server";

// ─── Creator Memory ───────────────────────────────────────────

export interface CreatorMemoryEntry {
  creator_wallet: string | null;
  source_url: string;
  source_domain: string | null;
  memory_type: "reliability" | "payout_history" | "contribution" | "overlap";
  safe_summary: string;
  reliability_score: number | null;
}

/**
 * Read creator memory for a specific source/creator combination.
 * Used by the Deep Agent evaluator for context.
 */
export async function readCreatorMemory(
  sourceUrl: string,
  creatorWallet: string | null
): Promise<CreatorMemoryEntry[]> {
  const db = supabaseAdmin();
  let query = db
    .from("paylabs_creator_memory")
    .select("*")
    .eq("source_url", sourceUrl)
    .order("updated_at", { ascending: false })
    .limit(10);

  if (creatorWallet) {
    query = query.eq("creator_wallet", creatorWallet.toLowerCase());
  } else {
    query = query.is("creator_wallet", null);
  }

  const { data, error } = await query;
  if (error) {
    console.warn("[creator-memory-read] error:", error.message);
    return [];
  }

  return (data || []).map((row) => ({
    creator_wallet: row.creator_wallet,
    source_url: row.source_url,
    source_domain: row.source_domain,
    memory_type: row.memory_type as CreatorMemoryEntry["memory_type"],
    safe_summary: row.safe_summary,
    reliability_score: row.reliability_score,
  }));
}

/**
 * Write creator memory summary.
 * Only stores safe metadata — never raw CoT or secrets.
 */
export async function writeCreatorMemorySummary(entry: {
  creator_wallet: string | null;
  source_url: string;
  source_domain: string | null;
  memory_type: CreatorMemoryEntry["memory_type"];
  safe_summary: string;
  reliability_score: number | null;
}): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("paylabs_creator_memory").upsert(
    {
      creator_wallet: entry.creator_wallet,
      source_url: entry.source_url,
      source_domain: entry.source_domain,
      memory_type: entry.memory_type,
      safe_summary: entry.safe_summary,
      reliability_score: entry.reliability_score,
      usage_count: 1,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "creator_wallet,source_url,memory_type",
      ignoreDuplicates: false,
    }
  );

  if (error) {
    console.warn("[creator-memory-write] error:", error.message);
  }
}

// ─── Evaluator Memory ─────────────────────────────────────────

export interface EvaluatorMemoryEntry {
  discovery_run_id: string;
  route_tier: string;
  source_ids: string[];
  source_urls: string[];
  safe_evaluator_summary: string;
  why_two_sources_needed: string | null;
  evaluator_confidence: number | null;
  warnings: string[];
}

/**
 * Read evaluator memory for similar source combinations.
 * Used by the Deep Agent evaluator for historical context.
 */
export async function readEvaluatorMemory(
  discoveryRunId: string,
  userGoal: string,
  selectedSources: string[]
): Promise<EvaluatorMemoryEntry[]> {
  const db = supabaseAdmin();

  // Find recent evaluator memories with overlapping sources
  const { data, error } = await db
    .from("paylabs_evaluator_memory")
    .select("*")
    .neq("discovery_run_id", discoveryRunId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.warn("[evaluator-memory-read] error:", error.message);
    return [];
  }

  // Filter for overlapping sources in application layer
  return (data || [])
    .filter((row) => {
      const memSources = (row.source_urls || []) as string[];
      return selectedSources.some((s) => memSources.includes(s));
    })
    .map((row) => ({
      discovery_run_id: row.discovery_run_id,
      route_tier: row.route_tier,
      source_ids: (row.source_ids || []) as string[],
      source_urls: (row.source_urls || []) as string[],
      safe_evaluator_summary: row.safe_evaluator_summary,
      why_two_sources_needed: row.why_two_sources_needed,
      evaluator_confidence: row.evaluator_confidence,
      warnings: (row.warnings || []) as string[],
    }));
}

/**
 * Write evaluator memory summary.
 * Only stores safe conclusions — never raw CoT or hidden reasoning.
 */
export async function writeEvaluatorMemorySummary(entry: {
  discovery_run_id: string;
  route_tier: string;
  source_ids: string[];
  source_urls: string[];
  safe_evaluator_summary: string;
  why_two_sources_needed: string | null;
  evaluator_confidence: number | null;
  warnings: string[];
}): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("paylabs_evaluator_memory").insert({
    discovery_run_id: entry.discovery_run_id,
    route_tier: entry.route_tier,
    source_ids: entry.source_ids,
    source_urls: entry.source_urls,
    safe_evaluator_summary: entry.safe_evaluator_summary,
    why_two_sources_needed: entry.why_two_sources_needed,
    evaluator_confidence: entry.evaluator_confidence,
    warnings: entry.warnings,
  });

  if (error) {
    console.warn("[evaluator-memory-write] error:", error.message);
  }
}
