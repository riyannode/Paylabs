// GET /api/paylabs/discovery-runs/[id]/status
//
// Returns safe progress fields for a discovery run.
// No raw signed context. No raw x-payment. No secrets. No Gateway internals.
// Visibility from canonical paylabs_service_payment_events (not legacy nanopayments).

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

  // ── Load service payment events ─────────────────────────────
  const { data: paymentEvents } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("seller, status, mode, amount_usdc, tx_hash")
    .eq("discovery_run_id", id)
    .order("created_at", { ascending: true });

  const events = (paymentEvents || []) as Array<{
    seller: string;
    status: string;
    mode: string;
    amount_usdc: number;
    tx_hash: string | null;
  }>;

  const paidServices = events.filter((e) => e.status === "paid").map((e) => e.seller);
  const failedServices = events.filter((e) => e.status === "failed").map((e) => e.seller);
  const totalPaid = paidServices.length;
  const totalSettledUsdc = events
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + Number(e.amount_usdc || 0), 0);

  // ── Load receipt ────────────────────────────────────────────
  const { data: receipt } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("actual_settled_usdc, payment_count, last_tx_hash, safe_receipt_summary")
    .eq("discovery_run_id", id)
    .maybeSingle();

  // Source path info from agent_trace
  const agentTrace = (run.agent_trace as Record<string, unknown>) || {};
  const sourcePathId = agentTrace.source_path_id as string | undefined;

  let sourcePathStatus: string | null = null;
  let selectedSourcesCount = 0;

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
  }

  return NextResponse.json({
    discovery_run_id: run.id,
    status: run.status,
    current_agent: run.current_agent || null,
    paid_services: paidServices,
    failed_services: failedServices,
    total_paid_services: totalPaid,
    total_settled_usdc: totalSettledUsdc,
    source_path_status: sourcePathStatus,
    selected_sources_count: selectedSourcesCount,
    error_summary: run.error_summary || null,
    queued_at: run.queued_at,
    started_at: run.started_at,
    completed_at: run.completed_at,
    receipt: receipt
      ? {
          actual_settled_usdc: receipt.actual_settled_usdc,
          payment_count: receipt.payment_count,
          last_tx_hash: receipt.last_tx_hash,
          safe_summary: receipt.safe_receipt_summary,
        }
      : null,
    payment_summary: {
      total: events.length,
      paid: paidServices.length,
      failed: failedServices.length,
      skipped: events.filter((e) => e.status === "skipped").length,
    },
  });
}
