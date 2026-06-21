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
// When PAYLABS_X402_ENABLED_SERVICE_NAMES is set and
// PAYLABS_AGENT_NANOPAYMENTS_ENABLED=true, initializes DCW signer
// for real x402 service edge payments.

export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  isDelegatedRuntimeEnabled,
  isDelegatedInlineExecutionEnabled,
  getX402EnabledServices,
  getPaymentFlags,
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
      runner_id: "vercel-inline", // DB column kept for schema compatibility
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
    // ── Inject DCW signer if x402 service edges are enabled ──
    const paymentFlags = getPaymentFlags();
    const x402Services = getX402EnabledServices();
    const needsDcwSigner =
      paymentFlags.agentNanopaymentsEnabled && x402Services.length > 0;

    if (needsDcwSigner) {
      const { setDcwSigner, getDcwSigner } = await import(
        "@/lib/paylabs/paid-agent-node"
      );
      if (!getDcwSigner()) {
        const { createDcwSigner } = await import(
          "@/lib/paylabs/x402/dcw-signer-adapter"
        );
        setDcwSigner(createDcwSigner());
      }
    }

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

    // Determine if any service was x402-settled
    const anySettled = result.serviceEvaluations?.some((e) => e.settled) ?? false;
    const overallMode = anySettled ? "x402" : "audit_only";

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: newStatus,
        completed_at: completedAt,
        candidate_count: result.serviceEvaluations?.length || 0,
        error_summary: result.error ? result.error.slice(0, 500) : null,
        agent_trace: {
          execution_origin: "vercel_inline",
          execution_mode: "inline_delegated",
          worker_used: false,
          phases_completed: result.phasesCompleted,
          brain_planning: result.brainPlanning
            ? { safe_summary: result.brainPlanning.safe_brain_summary }
            : null,
          service_evaluations: result.serviceEvaluations.map((e) => ({
            service: e.serviceName,
            status: e.status,
            summary: e.safeSummary,
            settled: e.settled,
            mode: e.mode,
          })),
          budget_snapshot: {
            settled_service_fees_usdc: result.budgetSnapshot.settledServiceFeesUsdc,
            estimated_service_fees_usdc: result.budgetSnapshot.estimatedServiceFeesUsdc,
          },
        },
      })
      .eq("id", discoveryRunId);

    // ── Return full result ──────────────────────────────────
    return NextResponse.json({
      ok: result.status === "completed",
      discovery_run_id: discoveryRunId,
      status: result.status,
      route_tier: result.routeTier,
      execution_origin: "vercel_inline",
      execution_mode: "inline_delegated",
      worker_used: false,
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
      settled: anySettled,
      mode: overallMode,
      error: result.error,
    });
  } catch (e: unknown) {
    // Sanitize: never expose raw stack traces, prompts, or internal details
    const rawMsg = e instanceof Error ? e.message : String(e);
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;

    // Mark run as failed
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_summary: `Inline execution failed: ${safeMsg}`.slice(0, 500),
      })
      .eq("id", discoveryRunId);

    return NextResponse.json(
      {
        ok: false,
        discovery_run_id: discoveryRunId,
        error: `Inline execution failed: ${safeMsg}`,
      },
      { status: 500 }
    );
  }
}
