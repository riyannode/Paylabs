/**
 * Discovery Pipeline — Unified LangGraph + Nanopayment Tracking
 *
 * Single entry point that:
 * 1. Creates a discovery run in DB
 * 2. Creates 7 nanopayment rows (planned)
 * 3. Runs the full LangGraph proposal pipeline (12 agents, all LLM-backed)
 * 4. Updates nanopayment rows based on which agents executed
 * 5. Returns combined results (pipeline output + payment state)
 *
 * This replaces the disconnected skeleton where:
 * - LangGraph pipeline existed but was never called from API
 * - Nanopayment rows were created but no agents ran
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import { proposeSourcePath } from "@/lib/ai-tutor/graph";
import {
  createNanopaymentRows,
  updateNanopaymentStatusByReceiptId,
} from "@/lib/paylabs/nanopayment-service";
import type { ExternalRouteTier } from "@/lib/paylabs/route-tier";
import type { RouteTier } from "@/lib/ai-tutor/route-config";

// ─── Types ─────────────────────────────────────────────────────

export interface RunDiscoveryPipelineInput {
  userWallet: string;
  goal: string;
  routeTier: ExternalRouteTier;
  budgetUsdc?: number;
}

export interface RunDiscoveryPipelineResult {
  ok: boolean;
  discoveryRunId?: string;
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

// ─── Main Entry ────────────────────────────────────────────────

export async function runDiscoveryPipeline(
  input: RunDiscoveryPipelineInput
): Promise<RunDiscoveryPipelineResult> {
  const tier = input.routeTier;
  const wallet = input.userWallet.toLowerCase();

  // ── Step 1: Create discovery run ─────────────────────────────
  const { data: runRow, error: runErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .insert({
      user_wallet: wallet,
      goal: input.goal,
      route_tier: tier,
      status: "discovery_only",
      payment_kind: "discovery_fee",
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return {
      ok: false,
      nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
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
    return {
      ok: false,
      discoveryRunId,
      nanopayments: { total: 0, completed: 0, failed: 0, skipped: 0, rows: [] },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: nanoResult.error,
    };
  }

  // Build receipt_id lookup: agent_name → receipt_id
  const receiptByAgent = new Map<string, string>();
  for (const row of nanoResult.rows) {
    receiptByAgent.set(row.agent_name, row.receipt_id);
  }

  // ── Step 3: Run LangGraph pipeline ──────────────────────────
  let pipelineResult: Record<string, unknown>;
  try {
    const result = await proposeSourcePath({
      userWallet: wallet,
      goal: input.goal,
      budgetUsdc: input.budgetUsdc || 0.01,
      routeTier: tier as RouteTier,
      discoveryRunId,
    });
    pipelineResult = result as Record<string, unknown>;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pipeline crashed — mark all nanopayments as failed
    for (const row of nanoResult.rows) {
      await updateNanopaymentStatusByReceiptId(row.receipt_id, "failed", {
        paymentRef: undefined,
        settlementRef: undefined,
      }).catch(() => {});
    }
    return {
      ok: false,
      discoveryRunId,
      nanopayments: {
        total: 7,
        completed: 0,
        failed: 7,
        skipped: 0,
        rows: nanoResult.rows.map((r) => ({
          agent_name: r.agent_name,
          status: "failed",
          receipt_id: r.receipt_id,
        })),
      },
      pipeline: { agentsRun: [], agentsFailed: [], selectedSources: [], verifiedSources: [], estimatedTotalUsdc: 0 },
      error: `Pipeline crashed: ${msg}`,
    };
  }

  // ── Step 4: Read nanopayment statuses (wrapper sets them inline) ──
  // The paid-node wrapper already updated each row to completed/failed
  // as each agent executed. We just read the final state here.
  const pipelineError = pipelineResult.error as string | undefined;
  const agentsRun: string[] = [];
  const agentsFailed: string[] = [];
  let completed = 0;
  let failed = 0;

  // Re-fetch rows to get wrapper-updated statuses
  const { getNanopaymentsByRun } = await import("@/lib/paylabs/nanopayment-service");
  const finalRows = await getNanopaymentsByRun(discoveryRunId);
  const finalByAgent = new Map(finalRows.map(r => [r.agent_name, r.status]));

  for (const row of nanoResult.rows) {
    const agentName = row.agent_name;
    const finalStatus = finalByAgent.get(agentName) || "skipped";
    const ran = finalStatus === "completed";

    if (ran) {
      agentsRun.push(agentName);
      completed++;
    } else {
      agentsFailed.push(agentName);
      failed++;
    }
  }

  // ── Step 5: Update discovery run status ─────────────────────
  const sourcePathStatus = (pipelineResult.sourcePathStatus as string) || "none";
  const newRunStatus = sourcePathStatus === "proposed" ? "paid_path_available" : "discovery_only";

  await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .update({
      status: newRunStatus,
      candidate_count: ((pipelineResult.eligibleSourceCount as number) || 0),
      eligible_source_count: ((pipelineResult.eligibleSourceCount as number) || 0),
      agent_trace: {
        agents_run: agentsRun,
        agents_failed: agentsFailed,
        pipeline_error: pipelineError || null,
        source_path_id: pipelineResult.sourcePathId || null,
      },
    })
    .eq("id", discoveryRunId);

  // ── Step 6: Return combined results ─────────────────────────
  return {
    ok: !pipelineError || agentsRun.length > 0,
    discoveryRunId,
    sourcePathId: pipelineResult.sourcePathId as string | undefined,
    sourcePathStatus,
    nanopayments: {
      total: 7,
      completed,
      failed,
      skipped: failed, // skipped = agents that didn't run
      rows: nanoResult.rows.map((r) => ({
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
