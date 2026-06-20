/**
 * Discovery Pipeline — Async Worker Architecture
 *
 * Split into two functions for async execution:
 *
 * 1. enqueueDiscoveryRun(input)
 *    - Validates budget
 *    - Creates discovery_run row (status: queued)
 *    - Creates exactly 7 planned nanopayment rows
 *    - Returns discoveryRunId
 *    - Does NOT call LangGraph
 *
 * 2. executeDiscoveryRun(discoveryRunId)
 *    - Loads discovery_run
 *    - Loads existing planned nanopayment rows
 *    - Builds paidReceiptIds map
 *    - Calls proposeSourcePath() (full 15-agent LangGraph)
 *    - Updates final run status
 *    - Never creates duplicate rows
 *
 * The HTTP route calls enqueueDiscoveryRun() and returns 202.
 * A background worker calls executeDiscoveryRun() and polls for queued runs.
 *
 * CRITICAL: The wrapper (withPaidNode) does NOT create rows.
 * This pipeline creates exactly 7 planned rows, then passes their
 * receipt IDs into the graph. The wrapper only UPDATES existing rows:
 *   planned → running → completed/failed
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import { proposeSourcePath } from "@/lib/ai-tutor/graph";
import {
  createNanopaymentRows,
  getNanopaymentsByRun,
  updateNanopaymentStatusByReceiptId,
} from "@/lib/paylabs/nanopayment-service";
import type { ExternalRouteTier } from "@/lib/paylabs/route-tier";
import { toInternalTier } from "@/lib/paylabs/route-tier";
import type { RouteTier } from "@/lib/ai-tutor/route-config";
import { validateRouteBudget } from "@/lib/ai-tutor/route-config";

// ─── Types ─────────────────────────────────────────────────────

export interface EnqueueInput {
  userWallet: string;
  goal: string;
  routeTier: ExternalRouteTier;
  budgetUsdc?: number;
}

export interface EnqueueResult {
  ok: boolean;
  discoveryRunId?: string;
  budgetError?: {
    routeTier: string;
    publicLabel: string;
    minUserBudgetUsdc: number;
    providedBudgetUsdc: number;
  };
  nanopayments: {
    total: number;
    rows: Array<{
      agent_name: string;
      status: string;
      receipt_id: string;
    }>;
  };
  error?: string;
}

export interface ExecuteResult {
  ok: boolean;
  discoveryRunId: string;
  sourcePathId?: string;
  sourcePathStatus?: string;
  nanopayments: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    rows: Array<{
      agent_name: string;
      status: string;
      receipt_id: string;
    }>;
  };
  pipeline: {
    agentsRun: string[];
    agentsFailed: string[];
    selectedSources: unknown[];
    verifiedSources: unknown[];
    estimatedTotalUsdc: number;
  };
  error?: string;
}

// ─── Enqueue: Validate + Create Rows (fast, no LLM) ───────────

export async function enqueueDiscoveryRun(
  input: EnqueueInput
): Promise<EnqueueResult> {
  const tier = input.routeTier;
  const wallet = input.userWallet.toLowerCase();
  const internalTier = toInternalTier(tier) as RouteTier;
  const userBudget = input.budgetUsdc ?? 0.01;

  // ── Step 0: Validate minimum budget ──────────────────────────
  const budgetCheck = validateRouteBudget(userBudget, internalTier);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      budgetError: {
        routeTier: tier,
        publicLabel: budgetCheck.publicLabel,
        minUserBudgetUsdc: budgetCheck.minRequired,
        providedBudgetUsdc: userBudget,
      },
      nanopayments: { total: 0, rows: [] },
      error: `Budget ${userBudget} USDC is below minimum ${budgetCheck.minRequired} USDC for ${budgetCheck.publicLabel} tier`,
    };
  }

  // ── Step 1: Create discovery run (status: queued) ────────────
  const now = new Date().toISOString();
  const { data: runRow, error: runErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .insert({
      user_wallet: wallet,
      goal: input.goal,
      route_tier: tier,
      status: "queued",
      payment_kind: "discovery_fee",
      queued_at: now,
      budget_usdc: userBudget,
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return {
      ok: false,
      nanopayments: { total: 0, rows: [] },
      error: `Failed to create discovery run: ${runErr?.message}`,
    };
  }

  const discoveryRunId = runRow.id as string;

  // ── Step 2: Create 7 nanopayment rows (planned) ─────────────
  const nanoResult = await createNanopaymentRows({
    discoveryRunId,
    userWallet: wallet,
    routeTier: tier,
  });

  if (nanoResult.error) {
    // Mark run as failed if nanopayment creation fails
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({ status: "failed", error_summary: nanoResult.error })
      .eq("id", discoveryRunId);

    return {
      ok: false,
      discoveryRunId,
      nanopayments: { total: 0, rows: [] },
      error: nanoResult.error,
    };
  }

  return {
    ok: true,
    discoveryRunId,
    nanopayments: {
      total: 7,
      rows: nanoResult.rows.map((r) => ({
        agent_name: r.agent_name,
        status: "planned",
        receipt_id: r.receipt_id,
      })),
    },
  };
}

// ─── Execute: Run LangGraph Pipeline (slow, LLM calls) ────────

export async function executeDiscoveryRun(
  discoveryRunId: string,
  runnerId?: string
): Promise<ExecuteResult> {
  const now = new Date().toISOString();

  // ── Step 1: Load discovery run ───────────────────────────────
  const { data: runRow, error: loadErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .select("*")
    .eq("id", discoveryRunId)
    .single();

  if (loadErr || !runRow) {
    return {
      ok: false,
      discoveryRunId,
      nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: `Discovery run not found: ${loadErr?.message}`,
    };
  }

  // Accept: queued (will mark running) OR already-running with matching runner_id
  // This handles both inline calls and worker-claimed runs.
  if (runRow.status === "queued") {
    // Claim: mark running
    const { error: claimErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "running",
        started_at: now,
        runner_id: runnerId || "vercel-inline",
        worker_heartbeat_at: now,
      })
      .eq("id", discoveryRunId)
      .eq("status", "queued"); // CAS guard

    if (claimErr) {
      return {
        ok: false,
        discoveryRunId,
        nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
        pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
        error: `Failed to claim run: ${claimErr.message}`,
      };
    }
  } else if (runRow.status === "running" && runRow.runner_id === runnerId) {
    // Already claimed by this same worker (retry/resume) — proceed
  } else {
    return {
      ok: false,
      discoveryRunId,
      nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: `Run is not claimable (status: ${runRow.status}, runner: ${runRow.runner_id})`,
    };
  }

  // ── Step 3: Load existing planned nanopayment rows ───────────
  const nanoRows = await getNanopaymentsByRun(discoveryRunId);
  const plannedRows = nanoRows.filter((r) => r.status === "planned");

  if (plannedRows.length === 0) {
    const err = "No planned nanopayment rows found";
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({ status: "failed", error_summary: err, completed_at: new Date().toISOString() })
      .eq("id", discoveryRunId);
    return {
      ok: false,
      discoveryRunId,
      nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: err,
    };
  }

  // Build receipt_id lookup: agent_name → receipt_id
  const receiptByAgent = new Map<string, string>();
  for (const row of plannedRows) {
    receiptByAgent.set(row.agent_name, row.receipt_id);
  }

  const tier = runRow.route_tier as ExternalRouteTier;
  const internalTier = toInternalTier(tier) as RouteTier;
  const wallet = runRow.user_wallet as string;
  const goal = runRow.goal as string;

  // ── Step 4: Run LangGraph pipeline ──────────────────────────
  let pipelineResult: Record<string, unknown>;
  try {
    // Update heartbeat before long-running pipeline
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({ worker_heartbeat_at: new Date().toISOString() })
      .eq("id", discoveryRunId);

    const result = await proposeSourcePath({
      userWallet: wallet,
      goal,
      budgetUsdc: Number(runRow.budget_usdc) || 0.01,
      routeTier: internalTier,
      discoveryRunId,
      paidReceiptIds: Object.fromEntries(receiptByAgent),
    });
    pipelineResult = result as Record<string, unknown>;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pipeline crashed — mark all nanopayments as failed
    for (const row of plannedRows) {
      await updateNanopaymentStatusByReceiptId(row.receipt_id, "failed", {
        paymentRef: undefined,
        settlementRef: undefined,
      }).catch(() => {});
    }
    const completedAt = new Date().toISOString();
    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "failed",
        error_summary: `Pipeline crashed: ${msg}`.slice(0, 500),
        completed_at: completedAt,
      })
      .eq("id", discoveryRunId);

    return {
      ok: false,
      discoveryRunId,
      nanopayments: {
        total: 7,
        completed: 0,
        failed: 7,
        skipped: 0,
        rows: plannedRows.map((r) => ({
          agent_name: r.agent_name,
          status: "failed",
          receipt_id: r.receipt_id,
        })),
      },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: `Pipeline crashed: ${msg}`,
    };
  }

  // ── Step 5: Read nanopayment statuses (wrapper sets them inline) ──
  const pipelineError = pipelineResult.error as string | undefined;
  const agentsRun: string[] = [];
  const agentsFailed: string[] = [];
  let completed = 0;
  let failed = 0;

  // Re-fetch rows to get wrapper-updated statuses
  const finalRows = await getNanopaymentsByRun(discoveryRunId);
  const finalByAgent = new Map(finalRows.map(r => [r.agent_name, r.status]));

  for (const row of plannedRows) {
    const agentName = row.agent_name;
    const finalStatus = finalByAgent.get(agentName) || "skipped";

    if (finalStatus === "completed") {
      agentsRun.push(agentName);
      completed++;
    } else {
      agentsFailed.push(agentName);
      failed++;
    }
  }

  // ── Step 6: Update discovery run status ─────────────────────
  const sourcePathStatus = (pipelineResult.sourcePathStatus as string) || "none";
  const newRunStatus = sourcePathStatus === "proposed" ? "paid_path_available" : "discovery_only";
  const completedAt = new Date().toISOString();

  await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({
      status: newRunStatus,
      completed_at: completedAt,
      candidate_count: ((pipelineResult.eligibleSourceCount as number) || 0),
      eligible_source_count: ((pipelineResult.eligibleSourceCount as number) || 0),
      agent_trace: {
        agents_run: agentsRun,
        agents_failed: agentsFailed,
        pipeline_error: pipelineError || null,
        source_path_id: pipelineResult.sourcePathId || null,
      },
      error_summary: pipelineError ? pipelineError.slice(0, 500) : null,
    })
    .eq("id", discoveryRunId);

  // ── Step 7: Return combined results ─────────────────────────
  return {
    ok: !pipelineError || agentsRun.length > 0,
    discoveryRunId,
    sourcePathId: pipelineResult.sourcePathId as string | undefined,
    sourcePathStatus,
    nanopayments: {
      total: 7,
      completed,
      failed,
      skipped: failed,
      rows: plannedRows.map((r) => ({
        agent_name: r.agent_name,
        status: (agentsRun.includes(r.agent_name) ? "completed" : "skipped"),
        receipt_id: r.receipt_id,
      })),
    },
    pipeline: {
      agentsRun,
      agentsFailed,
      selectedSources: (pipelineResult.selectedSources as unknown[]) || [],
      verifiedSources: (pipelineResult.verifiedSources as unknown[]) || [],
      estimatedTotalUsdc: (pipelineResult.estimatedTotalUsdc as number) || 0,
    },
    error: pipelineError || undefined,
  };
}
