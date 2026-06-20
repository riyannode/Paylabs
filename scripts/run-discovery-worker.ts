/**
 * Discovery Run Worker
 *
 * Polls for queued discovery runs, claims one safely, executes
 * the full LangGraph pipeline, and marks completed/failed.
 *
 * Usage: tsx scripts/run-discovery-worker.ts
 * Package: "worker:discovery": "tsx scripts/run-discovery-worker.ts"
 *
 * Safe logs only — no secrets, no env values, no wallet secrets,
 * no raw x-payment, no signed context, no full Gateway response.
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import { executeDiscoveryRun } from "@/lib/paylabs/discovery-pipeline";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 5000);
const RUNNER_ID = `worker-${process.pid}-${Date.now()}`;

async function claimNextRun(): Promise<string | null> {
  const now = new Date().toISOString();

  // Find oldest queued run
  const { data: queued } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("id")
    .eq("status", "queued")
    .order("queued_at", { ascending: true })
    .limit(1)
    .single();

  if (!queued) return null;

  // Try to claim it (CAS: only update if still queued)
  const { data: claimed, error } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({
      status: "running",
      started_at: now,
      runner_id: RUNNER_ID,
      worker_heartbeat_at: now,
    })
    .eq("id", queued.id)
    .eq("status", "queued") // CAS guard
    .select("id")
    .single();

  if (error || !claimed) {
    // Another worker claimed it first — not an error
    return null;
  }

  return claimed.id as string;
}

async function recoverStaleRuns(): Promise<void> {
  // Find runs stuck in 'running' for more than 5 minutes without heartbeat
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: staleRuns } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("id")
    .eq("status", "running")
    .lt("worker_heartbeat_at", staleThreshold);

  if (!staleRuns || staleRuns.length === 0) return;

  for (const run of staleRuns) {
    console.log(`[worker] Recovering stale run: ${run.id}`);
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "timed_out",
        error_summary: "Worker heartbeat timeout — run recovered",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
  }
}

async function runWorker(): Promise<void> {
  console.log(`[worker] Discovery worker started (runner_id: ${RUNNER_ID})`);
  console.log(`[worker] Polling every ${POLL_INTERVAL_MS}ms`);

  while (true) {
    try {
      // Recover stale runs first
      await recoverStaleRuns();

      // Try to claim a queued run
      const runId = await claimNextRun();

      if (runId) {
        console.log(`[worker] Claimed run: ${runId}`);

        const result = await executeDiscoveryRun(runId, RUNNER_ID);

        if (result.ok) {
          console.log(`[worker] Run completed: ${runId} (${result.nanopayments.completed}/7 agents, status: ${result.sourcePathStatus})`);
        } else {
          console.log(`[worker] Run failed: ${runId} — ${result.error}`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[worker] Error: ${msg}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ── Main ──────────────────────────────────────────────────────
runWorker().catch((e) => {
  console.error("[worker] Fatal error:", e);
  process.exit(1);
});
