// POST /api/paylabs/discovery-runs/inline
//
// Vercel inline delegated execution — no VPS worker required.
// Requires:
//   PAYLABS_DELEGATED_RUNTIME_ENABLED=true
//   PAYLABS_DELEGATED_INLINE_EXECUTION=true
//
// Creates a real Supabase discovery_run, runs the orchestrator
// directly (with LLM Brain + deterministic services), and returns
// the full structured result.
//
// This route does NOT modify the existing quote/enqueue flow.
// Service endpoints remain audit-only. No real delegated x402.

export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  isDelegatedRuntimeEnabled,
  isDelegatedInlineExecutionEnabled,
} from "@/lib/paylabs/feature-flags";
import { isValidExternalTier, DEFAULT_EXTERNAL_TIER } from "@/lib/paylabs/route-tier";
import type { ExternalRouteTier } from "@/lib/paylabs/route-tier";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";

export async function POST(req: NextRequest) {
  // ── Gate checks ───────────────────────────────────────────
  if (!isDelegatedRuntimeEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Delegated runtime is not enabled" },
      { status: 403 }
    );
  }

  if (!isDelegatedInlineExecutionEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Inline delegated execution is not enabled" },
      { status: 403 }
    );
  }

  // ── Parse body ────────────────────────────────────────────
  const body = await req.json().catch(() => ({}));
  const goal = (body.goal || "").trim();
  const userWallet = (body.user_wallet || "").trim().toLowerCase();
  const rawTier = (body.route_tier || DEFAULT_EXTERNAL_TIER).toLowerCase();
  const routeTier: ExternalRouteTier = isValidExternalTier(rawTier)
    ? (rawTier as ExternalRouteTier)
    : DEFAULT_EXTERNAL_TIER;
  const budgetUsdc = Number(body.budget_usdc) || 0.01;

  // ── Validate required fields ──────────────────────────────
  if (!goal) {
    return NextResponse.json(
      { ok: false, error: "goal is required" },
      { status: 400 }
    );
  }

  if (!userWallet || !/^0x[a-fA-F0-9]{40}$/.test(userWallet)) {
    return NextResponse.json(
      { ok: false, error: "user_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  if (budgetUsdc <= 0) {
    return NextResponse.json(
      { ok: false, error: "budget_usdc must be positive" },
      { status: 400 }
    );
  }

  // ── Create Supabase discovery_run row ─────────────────────
  const now = new Date().toISOString();
  const { data: runRow, error: runErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .insert({
      user_wallet: userWallet,
      goal,
      route_tier: routeTier,
      status: "running",
      payment_kind: "discovery_fee",
      queued_at: now,
      started_at: now,
      budget_usdc: budgetUsdc,
      runner_id: "vercel-inline",
      worker_heartbeat_at: now,
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to create discovery run: ${runErr?.message || "unknown"}`,
      },
      { status: 500 }
    );
  }

  const discoveryRunId = runRow.id as string;

  // ── Run orchestrator directly ─────────────────────────────
  try {
    const { executeDelegatedDiscoveryRun } = await import(
      "@/lib/paylabs/delegated-runtime/orchestrator"
    );

    // Map external tier to delegated tier (same values: easy/normal/advanced)
    const delegatedTier = routeTier as DelegatedRouteTier;

    const result = await executeDelegatedDiscoveryRun({
      discoveryRunId,
      userGoal: goal,
      userWallet,
      userBudgetUsdc: budgetUsdc,
      routeTier: delegatedTier,
    });

    // ── Update discovery_run with result ───────────────────
    const completedAt = new Date().toISOString();
    const newStatus = result.status === "completed"
      ? result.paymentPlan.length > 0 ? "paid_path_available" : "discovery_only"
      : "failed";

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: newStatus,
        completed_at: completedAt,
        candidate_count: result.serviceEvaluations?.length || 0,
        error_summary: result.error ? result.error.slice(0, 500) : null,
        agent_trace: {
          runner: "vercel-inline",
          phases_completed: result.phasesCompleted,
          brain_planning: result.brainPlanning
            ? { safe_summary: result.brainPlanning.safe_brain_summary }
            : null,
          service_evaluations: result.serviceEvaluations.map((e) => ({
            service: e.serviceName,
            status: e.status,
            summary: e.safeSummary,
          })),
        },
      })
      .eq("id", discoveryRunId);

    // ── Return full result ──────────────────────────────────
    return NextResponse.json({
      ok: result.status === "completed",
      discovery_run_id: discoveryRunId,
      status: result.status,
      route_tier: result.routeTier,
      phases_completed: result.phasesCompleted,
      brain_planning: result.brainPlanning
        ? {
            safe_summary: result.brainPlanning.safe_brain_summary,
            discovery_strategy: result.brainPlanning.discovery_strategy,
            query_variants: result.brainPlanning.suggested_query_variants,
          }
        : null,
      payment_plan: result.paymentPlan,
      safe_progress_summaries: result.safeProgressSummaries,
      budget_snapshot: result.budgetSnapshot,
      settled: false,
      mode: "audit_only",
      error: result.error,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // Mark run as failed
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_summary: `Inline execution failed: ${msg}`.slice(0, 500),
      })
      .eq("id", discoveryRunId);

    return NextResponse.json(
      {
        ok: false,
        discovery_run_id: discoveryRunId,
        error: `Inline execution failed: ${msg}`,
      },
      { status: 500 }
    );
  }
}
