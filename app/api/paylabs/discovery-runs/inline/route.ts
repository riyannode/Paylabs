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
//
// x402 ORCHESTRATION CHAIN (when PAYLABS_BRAIN_X402_ENABLED or
// PAYLABS_NODE_X402_ENABLED):
//   run_budget_controller → Brain (treasury 0.000003 USDC via Circle x402)
//   Brain → discovery_planner (macro allocation 0.000004 USDC via Circle x402)
//   Brain → payment_decision (macro allocation 0.000006 USDC via Circle x402)
//   Brain → settlement_memory (macro allocation 0.000002 USDC via Circle x402)
//   Each macro-node → child services (0.000001 USDC each, per-child Circle x402)

export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  isDelegatedRuntimeEnabled,
  isDelegatedInlineExecutionEnabled,
} from "@/lib/paylabs/feature-flags";
import { isValidExternalTier, DEFAULT_EXTERNAL_TIER } from "@/lib/paylabs/route-tier";
import type { ExternalRouteTier } from "@/lib/paylabs/route-tier";
import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import type { OrchestratorOutput, PaymentGraphEdge, TieredRunSummaries } from "@/lib/paylabs/delegated-runtime/types";
import { TIER_PHASE_MAP } from "@/lib/paylabs/delegated-runtime/state";
import { BRAIN_TREASURY_FEE_USDC, getMacroNodeAllocationUsdc } from "@/lib/paylabs/delegated-runtime/node-registry";
import type { MacroNodePhase } from "@/lib/paylabs/delegated-runtime/types";
import { randomUUID } from "node:crypto";

// ─── x402 Orchestration via callPaidSeller ──────────────────
// Each endpoint handles its own x402 settlement.
// callPaidSeller handles: send → 402 challenge → sign → retry.

async function resolveAppUrl(): Promise<string> {
  // Prefer VERCEL_URL (auto-set by Vercel to current deployment hostname)
  // to avoid chicken-and-egg: PAYLABS_APP_URL may point to old deployment
  const base = (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
    || process.env.PAYLABS_APP_URL
    || "";
  if (!base) throw new Error("config_error: No VERCEL_URL or PAYLABS_APP_URL");
  return base.replace(/\/+$/, "");
}

type X402CallResult = {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  paymentMetadata?: { txHash?: string | null; explorerUrl?: string | null } | null;
};

async function callBrainX402(dcwSigner: import("@/lib/paylabs/x402/buyer-transport").DcwSigner, body: {
  userGoal: string;
  routeTier: string;
  userBudgetUsdc: number;
  discoveryRunId: string;
}): Promise<X402CallResult> {
  const { callPaidSeller } = await import("@/lib/paylabs/x402/buyer-transport");

  const base = await resolveAppUrl();
  const result = await callPaidSeller(dcwSigner, {
    sellerUrl: `${base}/api/paylabs/brain/run`,
    method: "POST",
    body,
    buyerWalletId: process.env.PAYLABS_CONTROLLER_BUYER_WALLET_ID
      || process.env.PAYLABS_RUN_BUDGET_CONTROLLER_BUYER_WALLET_ID
      || "",
    buyerAgentName: "run_budget_controller",
    sellerServiceName: "brain" as import("@/lib/paylabs/agent-services/types").ServiceName,
    discoveryRunId: body.discoveryRunId,
    maxAmountUsdc: "0.001",
    requirePayment: true,
  });

  return {
    ok: result.ok,
    data: result.data as Record<string, unknown> | null,
    error: result.error || null,
    paymentMetadata: result.paymentMetadata ?? null,
  };
}

async function callMacroNodeX402(
  dcwSigner: import("@/lib/paylabs/x402/buyer-transport").DcwSigner,
  nodeName: string,
  body: {
    discoveryRunId: string;
    userGoal: string;
    routeTier: string;
    userBudgetUsdc: number;
    userWallet: string;
    payload?: Record<string, unknown>;
  }
): Promise<X402CallResult> {
  const { callPaidSeller } = await import("@/lib/paylabs/x402/buyer-transport");

  const base = await resolveAppUrl();
  const result = await callPaidSeller(dcwSigner, {
    sellerUrl: `${base}/api/paylabs/macro-nodes/${nodeName}/run`,
    method: "POST",
    body,
    buyerWalletId: process.env.PAYLABS_BRAIN_BUYER_WALLET_ID || "",
    buyerAgentName: "brain",
    sellerServiceName: nodeName as import("@/lib/paylabs/agent-services/types").ServiceName,
    discoveryRunId: body.discoveryRunId,
    maxAmountUsdc: "0.001",
    requirePayment: true,
  });

  return {
    ok: result.ok,
    data: result.data as Record<string, unknown> | null,
    error: result.error || null,
    paymentMetadata: result.paymentMetadata ?? null,
  };
}

// ─── x402 Orchestration Chain ───────────────────────────────
// Payment graph: controller → Brain → macro-node → child service

async function runX402Orchestration(params: {
  discoveryRunId: string;
  userGoal: string;
  userWallet: string;
  userBudgetUsdc: number;
  routeTier: DelegatedRouteTier;
  dcwSigner: import("@/lib/paylabs/x402/buyer-transport").DcwSigner;
}): Promise<OrchestratorOutput> {
  const { discoveryRunId, userGoal, userWallet, userBudgetUsdc, routeTier, dcwSigner } = params;
  const safeProgressSummaries: string[] = [];
  const paymentGraph: PaymentGraphEdge[] = [];

  safeProgressSummaries.push(
    `x402 orchestration started: tier=${routeTier}, budget=${userBudgetUsdc} USDC`
  );

  // ── Step 1: Brain (controller → Brain) ──
  const brainResult = await callBrainX402(dcwSigner, {
    userGoal,
    routeTier,
    userBudgetUsdc,
    discoveryRunId,
  });

  if (!brainResult.ok || !brainResult.data) {
    return buildX402Output(discoveryRunId, routeTier, userBudgetUsdc, "failed",
      [`Brain x402 failed: ${brainResult.error}`], paymentGraph, null, null, `Brain x402 failed: ${brainResult.error}`);
  }

  // Record controller → Brain edge (treasury payment)
  paymentGraph.push({
    edgeId: randomUUID(),
    buyer: "run_budget_controller",
    seller: "brain",
    amountUsdc: BRAIN_TREASURY_FEE_USDC,
    status: "paid",
    nodeType: "brain",
    paymentRef: null,
    txHash: brainResult.paymentMetadata?.txHash ?? null,
    explorerUrl: brainResult.paymentMetadata?.explorerUrl ?? null,
  });

  const brainData = brainResult.data.data as Record<string, unknown> | undefined;
  const executionPlan = brainResult.data.executionPlan as {
    selectedMacroNodes?: string[];
    selectedServices?: string[];
  } | undefined;
  const macroNodes: string[] = (executionPlan?.selectedMacroNodes as string[])
    || (TIER_PHASE_MAP[routeTier] || TIER_PHASE_MAP.easy);

  safeProgressSummaries.push(
    `Brain settled: ${macroNodes.length} macro-nodes, strategy="${String(brainData?.discovery_strategy || "").slice(0, 60)}"`
  );

  if (macroNodes.length === 0) {
    return buildX402Output(discoveryRunId, routeTier, userBudgetUsdc, "completed",
      safeProgressSummaries, paymentGraph, brainData || null, null, null);
  }

  // ── Steps 2-4: Macro-nodes (Brain → macro-node → child) ──
  const macroNodeResults: Record<string, Record<string, unknown>> = {};

  for (const node of macroNodes) {
    // Build payload: previous step's output feeds next step
    let payload: Record<string, unknown> = {};
    if (node === "payment_decision") {
      const prev = macroNodeResults["discovery_planner"];
      if (prev) {
        const d = (prev.data as Record<string, unknown>) || prev;
        // Macro-node returns camelCase (rankedCandidates)
        payload = { ranked_candidates: (d.rankedCandidates as unknown[]) || (d.ranked_candidates as unknown[]) || [] };
      }
    } else if (node === "settlement_memory") {
      const prev = macroNodeResults["payment_decision"];
      if (prev) {
        const d = (prev.data as Record<string, unknown>) || prev;
        // Macro-node returns camelCase (approvedItems/skippedItems)
        payload = {
          approved_items: (d.approvedItems as unknown[]) || (d.approved_items as unknown[]) || [],
          skipped_items: (d.skippedItems as unknown[]) || (d.skipped_items as unknown[]) || [],
        };
      }
    }

    safeProgressSummaries.push(`Calling macro-node ${node} (x402)...`);

    const nodeResult = await callMacroNodeX402(dcwSigner, node, {
      discoveryRunId,
      userGoal,
      routeTier,
      userBudgetUsdc,
      userWallet,
      payload,
    });

    if (!nodeResult.ok || !nodeResult.data) {
      paymentGraph.push({
        edgeId: randomUUID(),
        buyer: "brain",
        seller: node,
        amountUsdc: getMacroNodeAllocationUsdc(node as MacroNodePhase),
        status: "skipped",
        nodeType: "macro_node",
        paymentRef: null,
      });
      return buildX402Output(discoveryRunId, routeTier, userBudgetUsdc, "failed",
        [...safeProgressSummaries, `FAILED: Macro-node ${node}: ${nodeResult.error}`],
        paymentGraph, brainData || null, macroNodeResults, `Macro-node ${node} x402 failed: ${nodeResult.error}`);
    }

    // Record Brain → macro-node edge (macro allocation payment)
    paymentGraph.push({
      edgeId: randomUUID(),
      buyer: "brain",
      seller: node,
      amountUsdc: getMacroNodeAllocationUsdc(node as MacroNodePhase),
      status: "paid",
      nodeType: "macro_node",
      paymentRef: null,
      txHash: nodeResult.paymentMetadata?.txHash ?? null,
      explorerUrl: nodeResult.paymentMetadata?.explorerUrl ?? null,
    });

    macroNodeResults[node] = nodeResult.data;


    // Extract child service payment edges from macro-node serviceEvaluations
    const childEvals = nodeResult.data.serviceEvaluations as Array<{
      serviceName: string; status: string; settled: boolean; mode: string; costUsdc: number;
      txHash?: string | null; explorerUrl?: string | null;
      error?: string | null;
    }> | undefined;
    if (childEvals) {
      for (const ev of childEvals) {
        paymentGraph.push({
          edgeId: randomUUID(),
          buyer: node,  // parent macro-node is the buyer
          seller: ev.serviceName,
          amountUsdc: ev.costUsdc || 0.000001,
          status: ev.settled ? "paid" : ev.status === "failed" ? "failed" : "skipped",
          nodeType: "service",
          paymentRef: null,
          txHash: ev.txHash ?? null,
          explorerUrl: ev.explorerUrl ?? null,
          error: ev.error ?? null,
          mode: ev.mode,
        });
      }
    }

    const runnerData = (nodeResult.data.data as Record<string, unknown>) || nodeResult.data;
    if (node === "discovery_planner") {
      // Macro-node returns camelCase (rankedCandidates), not snake_case
      const candidates = (runnerData.rankedCandidates as unknown[]) || (runnerData.ranked_candidates as unknown[]) || [];
      safeProgressSummaries.push(`Discovery planner: ${candidates.length} candidates`);
    } else if (node === "payment_decision") {
      // Macro-node returns camelCase (approvedItems/skippedItems)
      const approved = (runnerData.approvedItems as unknown[]) || (runnerData.approved_items as unknown[]) || [];
      safeProgressSummaries.push(`Payment decision: ${approved.length} approved`);
    } else if (node === "settlement_memory") {
      const routed = (runnerData.routedItems as unknown[]) || (runnerData.routed_items as unknown[]) || [];
      safeProgressSummaries.push(`Settlement: ${routed.length} items routed`);
    }
  }

  safeProgressSummaries.push("x402 orchestration completed: all phases settled");

  return buildX402Output(discoveryRunId, routeTier, userBudgetUsdc, "completed",
    safeProgressSummaries, paymentGraph, brainData || null, macroNodeResults, null);
}

function buildX402Output(
  discoveryRunId: string,
  routeTier: DelegatedRouteTier,
  userBudgetUsdc: number,
  status: "completed" | "failed",
  safeProgressSummaries: string[],
  paymentGraph: PaymentGraphEdge[],
  brainData: Record<string, unknown> | null,
  macroNodeResults: Record<string, Record<string, unknown>> | null,
  error: string | null,
): OrchestratorOutput {
  const macroNodes = TIER_PHASE_MAP[routeTier] || TIER_PHASE_MAP.easy;

  // Build payment plan from payment_decision result
  const paymentResult = macroNodeResults?.["payment_decision"];
  const paymentRunnerData = paymentResult
    ? ((paymentResult.data as Record<string, unknown>) || paymentResult)
    : null;
  // Macro-node returns camelCase (approvedItems), fallback to snake_case
  const approvedItems = ((paymentRunnerData?.approvedItems as Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
  }>) || (paymentRunnerData?.approved_items as Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
  }>)) || [];
  const paymentPlan = approvedItems.map((item) => ({
    itemId: item.feed_item_id,
    sourceUrl: item.source_url,
    sourceTitle: item.source_title,
    priceUsdc: item.approved_price_usdc,
    approved: true,
    skipReason: null,
    finalScore: item.final_score,
    riskScore: item.risk_score,
  }));

  // ── Build tiered summaries from macro-node results ──
  const tieredSummaries: TieredRunSummaries = {
    final_summary: safeProgressSummaries.join(" | "),
  };

  // easy_summary from discovery_planner
  const discoveryResult = macroNodeResults?.["discovery_planner"];
  if (discoveryResult) {
    const d = (discoveryResult.data as Record<string, unknown>) || discoveryResult;
    const candidates = (d.rankedCandidates as unknown[]) || (d.ranked_candidates as unknown[]) || [];
    tieredSummaries.easy_summary = `Discovery: ${candidates.length} candidates found.`;
  }

  // normal_summary from payment_decision
  if (paymentRunnerData) {
    const approved = (paymentRunnerData.approvedItems as unknown[]) || (paymentRunnerData.approved_items as unknown[]) || [];
    const skipped = (paymentRunnerData.skippedItems as unknown[]) || (paymentRunnerData.skipped_items as unknown[]) || [];
    tieredSummaries.normal_summary = `Payment Decision: ${approved.length} approved, ${skipped.length} skipped.`;
  }

  // advanced_summary from settlement_memory
  const settlementResult = macroNodeResults?.["settlement_memory"];
  if (settlementResult) {
    const s = (settlementResult.data as Record<string, unknown>) || settlementResult;
    const routed = (s.routedItems as unknown[]) || (s.routed_items as unknown[]) || [];
    tieredSummaries.advanced_summary = `Settlement: ${routed.length} items routed.`;
  }

  // Compute settled spend from paymentGraph
  const settledSpendUsdc = paymentGraph
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  // Compute user budget spend (controller→brain + brain→macro edges only)
  const userBudgetSpendEdges = paymentGraph.filter(
    (e) => (e.buyer === "run_budget_controller" && e.seller === "brain") ||
           (e.buyer === "brain" && e.nodeType === "macro_node")
  );
  const userBudgetUsedUsdc = userBudgetSpendEdges
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  // Compute child payment volume (macro→child edges)
  const childPaymentEdges = paymentGraph.filter((e) => e.nodeType === "service");
  const childPaymentVolumeUsdc = childPaymentEdges
    .filter((e) => e.status === "paid")
    .reduce((sum, e) => sum + e.amountUsdc, 0);

  return {
    discoveryRunId,
    status,
    routeTier,
    phasesCompleted: (status === "completed" ? macroNodes : []) as OrchestratorOutput["phasesCompleted"],
    safeProgressSummaries,
    budgetSnapshot: {
      totalBudgetUsdc: userBudgetUsdc,
      spentUsdc: settledSpendUsdc,
      remainingUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      serviceSpend: {} as Record<string, number>,
      settledServiceFeesUsdc: settledSpendUsdc,
      estimatedServiceFeesUsdc: 0,
      userBudgetUsdc,
      userBudgetUsedUsdc,
      remainingBudgetUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      treasuryFeeUsdc: BRAIN_TREASURY_FEE_USDC,
      macroAllocationUsdc: userBudgetUsedUsdc - BRAIN_TREASURY_FEE_USDC,
      childPaymentVolumeUsdc,
      grossPaymentVolumeUsdc: userBudgetUsedUsdc + childPaymentVolumeUsdc,
    },
    consensusDecisions: [],
    paymentPlan,
    paymentEdges: [],
    serviceEvaluations: [],
    brainPlanning: brainData as OrchestratorOutput["brainPlanning"],
    paymentGraph,
    tieredSummaries,
    error,
  };
}

// ─── Main Handler ────────────────────────────────────────────

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

  // ── x402 orchestration: Brain + macro-node endpoints ────
  // Fail closed: x402 must be enabled for production
  return runX402Path(discoveryRunId, goal, userWallet, budgetUsdc, routeTier);
}

// ─── x402 Path ──────────────────────────────────────────────

async function runX402Path(
  discoveryRunId: string,
  goal: string,
  userWallet: string,
  budgetUsdc: number,
  routeTier: ExternalRouteTier,
): Promise<NextResponse> {
  try {
    // Initialize DCW signer for x402 payment signing
    const { setDcwSigner, getDcwSigner, createDcwSigner } = await import("@/lib/paylabs/x402/dcw-signer-adapter");
    if (!getDcwSigner()) {
      setDcwSigner(createDcwSigner());
    }
    const dcwSigner = getDcwSigner();
    if (!dcwSigner) {
      throw new Error("DCW signer initialization failed");
    }

    // ── Env preflight: fail closed if any required x402 env is missing ──
    const requiredEnvs = [
      "PAYLABS_DELEGATED_RUNTIME_ENABLED",
      "PAYLABS_DELEGATED_INLINE_EXECUTION",
      "PAYLABS_AGENT_NANOPAYMENTS_ENABLED",
      "PAYLABS_BRAIN_X402_ENABLED",
      "PAYLABS_NODE_X402_ENABLED",
      "PAYLABS_APP_URL",
      "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
      "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
    ];
    const missingEnvs = requiredEnvs.filter((k) => !process.env[k]);
    if (missingEnvs.length > 0) {
      throw new Error(`config_error: missing required x402 envs: ${missingEnvs.join(", ")}`);
    }

    // Controller buyer wallet — support both naming conventions
    const controllerBuyerWalletId = process.env.PAYLABS_CONTROLLER_BUYER_WALLET_ID
      || process.env.PAYLABS_RUN_BUDGET_CONTROLLER_BUYER_WALLET_ID;
    if (!controllerBuyerWalletId) {
      throw new Error("config_error: missing controller buyer wallet id (set PAYLABS_CONTROLLER_BUYER_WALLET_ID or PAYLABS_RUN_BUDGET_CONTROLLER_BUYER_WALLET_ID)");
    }

    // Brain buyer wallet
    if (!process.env.PAYLABS_BRAIN_BUYER_WALLET_ID) {
      throw new Error("config_error: missing PAYLABS_BRAIN_BUYER_WALLET_ID");
    }

    // Discovery planner buyer wallet (for child service payments)
    if (!process.env.PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID) {
      throw new Error("config_error: missing PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID");
    }

    // ── Tier-specific env preflight: fail fast before orchestration ──
    const tierRequiredEnv: string[] = [
      "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
      "PAYLABS_BRAIN_BUYER_WALLET_ID",
      "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
      "PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID",
    ];

    if (routeTier === "normal" || routeTier === "advanced") {
      tierRequiredEnv.push(
        "PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS",
        "PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID",
      );
    }

    if (routeTier === "advanced") {
      tierRequiredEnv.push(
        "PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS",
        "PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID",
        "PAYLABS_SERVICE_PAYMENT_ROUTER_SELLER_WALLET_ADDRESS",
      );
    }

    const missingTierEnv = tierRequiredEnv.filter((key) => !process.env[key]);
    if (missingTierEnv.length > 0) {
      throw new Error(`config_error: missing tier x402 envs: ${missingTierEnv.join(", ")}`);
    }

    const result = await runX402Orchestration({
      discoveryRunId,
      userGoal: goal,
      userWallet,
      userBudgetUsdc: budgetUsdc,
      routeTier: routeTier as DelegatedRouteTier,
      dcwSigner,
    });

    const completedAt = new Date().toISOString();
    const newStatus = result.status === "completed"
      ? result.paymentGraph.some((e) => e.status === "paid") ? "paid_path_available" : "discovery_only"
      : "failed";

    // Compute settled from actual paymentGraph — never assume settled on partial failure
    const fullySettled = result.status === "completed"
      && result.paymentGraph.length > 0
      && result.paymentGraph.every((e) => e.status === "paid");

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: newStatus,
        completed_at: completedAt,
        candidate_count: result.serviceEvaluations?.length || 0,
        error_summary: result.error ? result.error.slice(0, 500) : null,
        agent_trace: {
          execution_origin: "vercel_inline",
          execution_mode: "x402_orchestration",
          worker_used: false,
          x402_enabled: true,
          phases_completed: result.phasesCompleted,
          brain_planning: result.brainPlanning
            ? {
                safe_summary: result.brainPlanning.safe_brain_summary,
                selected_macro_nodes: result.brainPlanning.selected_macro_nodes,
                selected_services: result.brainPlanning.selected_services,
                planned_cost_usdc: result.brainPlanning.planned_cost_usdc,
              }
            : null,
          payment_graph: result.paymentGraph.map((e) => ({
            buyer: e.buyer,
            seller: e.seller,
            node_type: e.nodeType,
            status: e.status,
            tx_hash: e.txHash ?? null,
            explorer_url: e.explorerUrl ?? null,
            error: e.error ?? null,
            mode: e.mode ?? null,
          })),
          budget_snapshot: {
            settled_service_fees_usdc: result.budgetSnapshot.settledServiceFeesUsdc,
            estimated_service_fees_usdc: result.budgetSnapshot.estimatedServiceFeesUsdc,
          },
        },
      })
      .eq("id", discoveryRunId);

    // ── Build exit output ──
    const { buildExitOutput } = await import("@/lib/paylabs/delegated-runtime/exit-output");
    const exitOutput = buildExitOutput(result);

    // ── Write canonical x402 visibility (events + receipt) ──
    let visibilityError: string | null = null;
    try {
      const { writePayLabsVisibility } = await import("@/lib/paylabs/visibility/writer");
      await writePayLabsVisibility({
        discoveryRunId,
        userWallet,
        routeTier: routeTier as DelegatedRouteTier,
        result,
      });
    } catch (e) {
      visibilityError = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      console.error("[paylabs_visibility] write failed", {
        discoveryRunId,
        error: visibilityError,
      });
    }

    return NextResponse.json({
      ok: result.status === "completed",
      discovery_run_id: discoveryRunId,
      status: result.status,
      route_tier: result.routeTier,
      execution_origin: "vercel_inline",
      execution_mode: "x402_orchestration",
      worker_used: false,
      x402_enabled: true,
      phases_completed: result.phasesCompleted,
      brain_planning: result.brainPlanning
        ? {
            safe_summary: result.brainPlanning.safe_brain_summary,
            discovery_strategy: result.brainPlanning.discovery_strategy,
            query_variants: result.brainPlanning.suggested_query_variants,
            selected_macro_nodes: result.brainPlanning.selected_macro_nodes,
            selected_services: result.brainPlanning.selected_services,
            max_registry_checks: result.brainPlanning.max_registry_checks,
            max_source_accesses: result.brainPlanning.max_source_accesses,
            planned_cost_usdc: result.brainPlanning.planned_cost_usdc,
            planned_cost_breakdown: result.brainPlanning.planned_cost_breakdown,
          }
        : null,
      payment_plan: result.paymentPlan,
      payment_graph: result.paymentGraph.map((e) => ({
        edge_id: e.edgeId,
        buyer: e.buyer,
        seller: e.seller,
        amount_usdc: e.amountUsdc,
        status: e.status,
        node_type: e.nodeType,
        tx_hash: e.txHash ?? null,
        explorer_url: e.explorerUrl ?? null,
        error: e.error ?? null,
        mode: e.mode ?? null,
      })),
      safe_progress_summaries: result.safeProgressSummaries,
      budget_snapshot: result.budgetSnapshot,
      tiered_summaries: result.tieredSummaries,
      exit_output: exitOutput,
      receipt_ready: exitOutput.receipt_ready && !visibilityError,
      settled: fullySettled,
      mode: fullySettled ? "x402" : "x402_failed",
      error: result.error,
      visibility_error: visibilityError,
    });
  } catch (e: unknown) {
    const rawMsg = e instanceof Error ? e.message : String(e);
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + "..." : rawMsg;

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_summary: `x402 orchestration failed: ${safeMsg}`.slice(0, 500),
      })
      .eq("id", discoveryRunId);

    return NextResponse.json(
      {
        ok: false,
        discovery_run_id: discoveryRunId,
        error: `x402 orchestration failed: ${safeMsg}`,
      },
      { status: 500 }
    );
  }
}


