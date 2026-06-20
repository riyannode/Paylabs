// GET /api/paylabs/discovery-runs/[id]/status
//
// Returns safe progress fields for a discovery run.
// No raw signed context. No raw x-payment. No secrets. No Gateway internals.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id) {
    return NextResponse.json({ error: "discovery_run_id required" }, { status: 400 });
  }

  // ── Load discovery run ───────────────────────────────────────
  const { data: run, error: runErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("id, status, goal, route_tier, current_agent, error_summary, queued_at, started_at, completed_at, candidate_count, eligible_source_count, agent_trace")
    .eq("id", id)
    .single();

  if (runErr || !run) {
    return NextResponse.json({ error: "Discovery run not found" }, { status: 404 });
  }

  // ── Load nanopayment row summary ─────────────────────────────
  const { data: nanoRows } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .select("agent_name, status, receipt_id")
    .eq("discovery_run_id", id)
    .order("created_at", { ascending: true });

  const rows = (nanoRows || []) as Array<{ agent_name: string; status: string; receipt_id: string }>;

  // Aggregate agent statuses
  const completedAgents = rows.filter((r) => r.status === "completed").map((r) => r.agent_name);
  const failedAgents = rows.filter((r) => r.status === "failed" || r.status === "config_error").map((r) => r.agent_name);
  const runningAgents = rows.filter((r) => r.status === "running").map((r) => r.agent_name);
  const totalPaidAgents = rows.filter((r) => r.status === "completed" || r.status === "running").length;

  // Source path info from agent_trace
  const agentTrace = (run.agent_trace as Record<string, unknown>) || {};
  const sourcePathId = agentTrace.source_path_id as string | undefined;

  // Source path status (if source path was created)
  let sourcePathStatus: string | null = null;
  let selectedSourcesCount = 0;
  let verifiedSourcesCount = 0;

  if (sourcePathId) {
    const { data: pathRow } = await supabaseAdmin()
      .from("paylabs_source_paths")
      .select("status")
      .eq("id", sourcePathId)
      .single();

    sourcePathStatus = (pathRow?.status as string) || null;

    const { data: pathItems } = await supabaseAdmin()
      .from("paylabs_source_path_items")
      .select("id")
      .eq("source_path_id", sourcePathId);

    selectedSourcesCount = (pathItems || []).length;

    const { data: verifiedItems } = await supabaseAdmin()
      .from("paylabs_source_path_items")
      .select("id")
      .eq("source_path_id", sourcePathId)
      .eq("status", "proposed");

    verifiedSourcesCount = (verifiedItems || []).length;
  }

  return NextResponse.json({
    discovery_run_id: run.id,
    status: run.status,
    current_agent: run.current_agent || null,
    completed_agents: completedAgents,
    failed_agents: failedAgents,
    running_agents: runningAgents,
    total_paid_agents: totalPaidAgents,
    source_path_status: sourcePathStatus,
    selected_sources_count: selectedSourcesCount,
    verified_sources_count: verifiedSourcesCount,
    error_summary: run.error_summary || null,
    queued_at: run.queued_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    nanopayment_summary: {
      total: rows.length,
      completed: completedAgents.length,
      failed: failedAgents.length,
      running: runningAgents.length,
      planned: rows.filter((r) => r.status === "planned").length,
    },
  });
}
