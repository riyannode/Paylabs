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
import { resolveAutoTier } from "@/lib/paylabs/delegated-runtime/state";
import { validateAndLockExecutionPlan } from "@/lib/paylabs/delegated-runtime/state";
import { getMacroNodeAllocationUsdcForTier } from "@/lib/paylabs/delegated-runtime/node-registry";
import { FIXED_FEES_USDC } from "@/lib/paylabs/delegated-runtime/quote-engine";
import type { MacroNodePhase } from "@/lib/paylabs/delegated-runtime/types";
import {
  quoteDelegatedRun,
  assertBudgetOrThrow,
} from "@/lib/paylabs/delegated-runtime/quote-engine";
import type { DelegatedRunQuote } from "@/lib/paylabs/delegated-runtime/quote-engine";
import { randomUUID } from "node:crypto";
import { resolvePaylabsAppUrl, resolvePublicAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";

// ─── x402 Orchestration via callPaidSeller ──────────────────
// Each endpoint handles its own x402 settlement.
// callPaidSeller handles: send → 402 challenge → sign → retry.

async function resolveAppUrl(): Promise<string> {
  const { baseUrl } = resolvePaylabsAppUrl();
  return baseUrl;
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

  // ── Safe diagnostics: use shared resolver source (no secrets) ──
  const { source: selectedBaseSource, hostname: sellerHostname } = resolvePaylabsAppUrl();
  const sellerPath = "/api/paylabs/brain/run";

  if (process.env.NODE_ENV !== "production") {
    console.debug("[x402_self_call_debug] sellerService=brain", {
      selectedBaseSource,
      sellerHostname,
      sellerPath,
      discoveryRunIdShort: body.discoveryRunId?.substring(0, 8),
    });
  }

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

  // ── Safe diagnostics: log self-call result (no secrets) ──
  if (process.env.NODE_ENV !== "production") {
    console.debug("[x402_self_call_debug] result sellerService=brain", {
      ok: result.ok,
      status: result.status ?? "n/a",
      hasError: !!result.error,
      errorClass: result.error?.substring(0, 80) || "none",
    });
  }

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
}): Promise<OrchestratorOutput & { _lockedPlan?: import("@/lib/paylabs/delegated-runtime/types").ExecutionPlan | null }> {
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
    amountUsdc: FIXED_FEES_USDC.brainTreasury,
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

  // ── Brain LLM Planning (after x402 settle, direct call — no HTTP timeout) ──
  let fullBrainPlanning: Record<string, unknown> | null = null;
  let capturedBrainLlmDiag: Record<string, unknown> | undefined = undefined;
  try {
    const { runBrainPlannerGraph } = await import("@/lib/paylabs/langgraph/brain/brain-planner-graph");
    const planResult = await runBrainPlannerGraph({
      discoveryRunId,
      userGoal,
      routeTier,
      userBudgetUsdc,
      userWallet,
    });

    capturedBrainLlmDiag = planResult.brainLlmDiag ?? undefined;
    // ── Safe diagnostics: Brain planner result (no raw LLM, no secrets) ──
    const VALID_TIER_SET = new Set(["easy", "normal", "advanced"]);
    const diagHint = planResult.brainPlanning?.route_tier_hint;
    const diagHintStr: string | undefined = diagHint;
    const diagHintValid = diagHintStr !== undefined && VALID_TIER_SET.has(diagHintStr);
    // Safe diagnostics (gated — no raw LLM, no secrets)
    if (process.env.NODE_ENV !== "production") {
      console.log("[inline] Brain planner diagnostics", {
        planResult_ok: planResult.ok,
        hasBrainPlanning: !!planResult.brainPlanning,
        planResult_error: planResult.error ? planResult.error.slice(0, 160) : null,
        route_tier_hint_present: diagHintStr !== undefined && diagHintStr !== null,
        route_tier_hint_value: diagHintValid ? diagHintStr : (diagHintStr === null ? "null" : diagHintStr === undefined ? "none" : "invalid"),
        selected_macro_nodes_count: planResult.brainPlanning?.selected_macro_nodes?.length ?? 0,
        selected_services_count: planResult.brainPlanning?.selected_services?.length ?? 0,
      });
    }

    // When Brain planner fails, store safe error so downstream can propagate it
    if (!planResult.ok) {
      const safeErr = planResult.error ? planResult.error.slice(0, 200) : "Brain planner returned ok=false";
      fullBrainPlanning = { error: safeErr, route_tier_hint: null } as Record<string, unknown>;
    }

    if (planResult.ok && planResult.brainPlanning) {
      const bp = planResult.brainPlanning;
      fullBrainPlanning = {
        normalized_goal: bp.normalized_goal,
        route_tier_hint: bp.route_tier_hint,
        discovery_strategy: bp.discovery_strategy,
        suggested_query_variants: bp.suggested_query_variants,
        service_execution_plan: bp.service_execution_plan,
        safe_brain_summary: bp.safe_brain_summary,
        assistant_response: bp.assistant_response,
        user_visible_reasoning: bp.user_visible_reasoning,
        tier_decision_reason: bp.tier_decision_reason,
        plan_rationale: bp.plan_rationale,
        selected_macro_nodes: bp.selected_macro_nodes,
        selected_services: bp.selected_services,
        max_registry_checks: bp.max_registry_checks,
        max_source_accesses: bp.max_source_accesses,
        planned_cost_usdc: bp.planned_cost_usdc,
        planned_cost_breakdown: bp.planned_cost_breakdown,
      };
    }
  } catch (e: unknown) {
    const brainErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    console.error("[inline] Brain planner failed after x402 settle", {
      error: brainErr,
    });
    // Store safe error so downstream can propagate it (no raw LLM output)
    fullBrainPlanning = { error: brainErr } as Record<string, unknown>;
  }

  // Use full planning output if available, fallback to brainData (x402 response)
  const resolvedBrainData = fullBrainPlanning || brainData || null;

  // ── Auto-tier resolution: "auto" → Brain's route_tier_hint ──
  const brainHint = resolvedBrainData
    ? (resolvedBrainData as Record<string, unknown>).route_tier_hint as string | undefined
    : undefined;
  const tierResult = resolveAutoTier(routeTier, brainHint);

  if (!tierResult.ok) {
    // auto tier: Brain LLM is mandatory — return direct error JSON, never successful run
    console.error("[inline] Brain planner failed for auto tier", {
      error: tierResult.error,
      hasBrainPlanning: !!fullBrainPlanning,
    });
    const failOutput = buildX402Output(discoveryRunId, "easy", userBudgetUsdc, "failed",
      [...safeProgressSummaries, `FAILED: ${tierResult.error}`], paymentGraph, fullBrainPlanning, null, tierResult.error);
    return { ...failOutput, _lockedPlan: null, _brainLlmDiag: capturedBrainLlmDiag };
  }
  const effectiveRouteTier = tierResult.tier;

  safeProgressSummaries.push(
    `Tier resolved: requested="${routeTier}", effective="${effectiveRouteTier}", brain_hint="${brainHint || "none"}"`
  );

  // ── Tier-specific env preflight (after tier resolution) ──
  const tierRequiredEnv: string[] = [
    "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
    "PAYLABS_BRAIN_BUYER_WALLET_ID",
    "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
    "PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID",
  ];
  if (effectiveRouteTier === "normal" || effectiveRouteTier === "advanced") {
    tierRequiredEnv.push(
      "PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS",
      "PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID",
      "PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS",
      "PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID",
      "PAYLABS_SERVICE_CREATOR_ATTRIBUTION_SELLER_WALLET_ADDRESS",
      "PAYLABS_SERVICE_CREATOR_ATTRIBUTION_BUYER_WALLET_ID",
      "PAYLABS_SERVICE_CREATOR_PAYOUT_ROUTER_SELLER_WALLET_ADDRESS",
      "PAYLABS_SERVICE_CREATOR_PAYOUT_ROUTER_BUYER_WALLET_ID",
    );
    // Payout funding wallet — required for creator payouts
    if (!process.env.PAYLABS_CREATOR_PAYOUT_BUYER_WALLET_ID && !process.env.PAYLABS_SETTLEMENT_TREASURY_WALLET_ID) {
      throw new Error(
        "config_error: PAYLABS_CREATOR_PAYOUT_BUYER_WALLET_ID or PAYLABS_SETTLEMENT_TREASURY_WALLET_ID required for normal/advanced tier"
      );
    }
  }
  if (effectiveRouteTier === "advanced") {
    tierRequiredEnv.push(
      "PAYLABS_SERVICE_ADVANCED_EVIDENCE_EVALUATOR_SELLER_WALLET_ADDRESS",
      "PAYLABS_SERVICE_ADVANCED_EVIDENCE_EVALUATOR_BUYER_WALLET_ID",
    );
  }
  const missingTierEnv = tierRequiredEnv.filter((key) => !process.env[key]);
  if (missingTierEnv.length > 0) {
    throw new Error(`config_error: missing tier x402 envs: ${missingTierEnv.join(", ")}`);
  }

  // ── Lock execution plan from Brain proposal + canonical tier bundle ──
  const bp = resolvedBrainData as Record<string, unknown> | null;
  const lockedPlan = validateAndLockExecutionPlan(
    effectiveRouteTier,
    ((bp?.selected_macro_nodes as string[]) || []) as import("@/lib/paylabs/delegated-runtime/types").MacroNodePhase[],
    ((bp?.selected_services as string[]) || []) as import("@/lib/paylabs/agent-services/types").ServiceName[],
    (bp?.max_registry_checks as number) ?? 10,
    (bp?.max_source_accesses as number) ?? 10,
  );
  const macroNodes = lockedPlan.selectedMacroNodes;

  // ── Runtime assertion: Easy tier MUST use signal_scout_basics ──
  if (effectiveRouteTier === "easy") {
    const hasBasics = lockedPlan.selectedServices.includes("signal_scout_basics" as import("@/lib/paylabs/agent-services/types").ServiceName);
    const hasRich = lockedPlan.selectedServices.includes("signal_scout" as import("@/lib/paylabs/agent-services/types").ServiceName);
    if (!hasBasics || hasRich) {
      const svcList = lockedPlan.selectedServices.join(", ");
      const assertionMsg = `ASSERTION FAILED: Easy tier locked plan must use signal_scout_basics, got: [${svcList}]`;
      console.error("[inline] " + assertionMsg, { effectiveRouteTier, selectedServices: lockedPlan.selectedServices });
      // Fail closed — do not execute with wrong service bundle
      const failOutput = buildX402Output(discoveryRunId, effectiveRouteTier, userBudgetUsdc, "failed",
        [...safeProgressSummaries, `FAILED: ${assertionMsg}`], paymentGraph, resolvedBrainData || null, null, assertionMsg, undefined, lockedPlan);
      return { ...failOutput, _lockedPlan: lockedPlan };
    }
  }

  // ── Budget guard: fail closed if locked plan exceeds user budget ──
  if (lockedPlan.plannedCostUsdc > userBudgetUsdc) {
    const budgetFailMsg = `Brain locked plan exceeds user budget: planned=${lockedPlan.plannedCostUsdc.toFixed(6)}, budget=${userBudgetUsdc}`;
    const failOutput = buildX402Output(discoveryRunId, effectiveRouteTier, userBudgetUsdc, "failed",
      [...safeProgressSummaries, `FAILED: ${budgetFailMsg}`], paymentGraph, resolvedBrainData || null, null, budgetFailMsg, undefined, lockedPlan);
    return { ...failOutput, _lockedPlan: lockedPlan };
  }

  safeProgressSummaries.push(
    `Brain settled: ${macroNodes.length} macro-nodes, strategy="${String(resolvedBrainData?.discovery_strategy || "").slice(0, 60)}"`
  );

  if (macroNodes.length === 0) {
    const zeroOutput = buildX402Output(discoveryRunId, effectiveRouteTier, userBudgetUsdc, "completed",
      safeProgressSummaries, paymentGraph, resolvedBrainData || null, null, null, undefined, lockedPlan);
    return { ...zeroOutput, _lockedPlan: lockedPlan };
  }

  // ── Steps 2-4: Macro-nodes (Brain → macro-node → child) ──
  const macroNodeResults: Record<string, Record<string, unknown>> = {};

  for (const node of macroNodes) {
    // Build payload: previous step's output feeds next step
    let payload: Record<string, unknown> = {};
    if (node === "discovery_planner") {
      // V3: Pass Brain planning fields to discovery_planner for better query expansion
      const bp = resolvedBrainData as Record<string, unknown> | null;
      if (bp) {
        payload = {
          brain_normalized_goal: bp.normalized_goal || null,
          brain_discovery_strategy: bp.discovery_strategy || null,
          brain_suggested_query_variants: bp.suggested_query_variants || [],
          brain_safe_summary: bp.safe_brain_summary || null,
        };
      }
    } else if (node === "payment_decision") {
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
      routeTier: effectiveRouteTier,
      userBudgetUsdc,
      userWallet,
      payload,
    });

    if (!nodeResult.ok || !nodeResult.data) {
      paymentGraph.push({
        edgeId: randomUUID(),
        buyer: "brain",
        seller: node,
        amountUsdc: getMacroNodeAllocationUsdcForTier(node as MacroNodePhase, effectiveRouteTier),
        status: "skipped",
        nodeType: "macro_node",
        paymentRef: null,
      });
      const macroFailOutput = buildX402Output(discoveryRunId, effectiveRouteTier, userBudgetUsdc, "failed",
        [...safeProgressSummaries, `FAILED: Macro-node ${node}: ${nodeResult.error}`],
        paymentGraph, resolvedBrainData || null, macroNodeResults, `Macro-node ${node} x402 failed: ${nodeResult.error}`, undefined, lockedPlan);
      return { ...macroFailOutput, _lockedPlan: lockedPlan };
    }

    // Record Brain → macro-node edge (macro allocation payment)
    paymentGraph.push({
      edgeId: randomUUID(),
      buyer: "brain",
      seller: node,
      amountUsdc: getMacroNodeAllocationUsdcForTier(node as MacroNodePhase, effectiveRouteTier),
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

  // ── Resolve source context from discovery_planner ranked candidates (PR #26) ──
  let sourceContext: import("@/lib/paylabs/sources/types").SourceContext | undefined;
  let serviceRetrievalMode: string | undefined;
  const discoveryMacroResult = macroNodeResults["discovery_planner"];
  if (discoveryMacroResult) {
    const dData = (discoveryMacroResult.data as Record<string, unknown>) || discoveryMacroResult;
    const rankedCandidates = ((dData.rankedCandidates as Array<{ feed_item_id: string; rank: number; relevance_score: number }>)
      || (dData.ranked_candidates as Array<{ feed_item_id: string; rank: number; relevance_score: number }>)
      || []);

    // Extract retrieval_mode from discovery_planner service output
    serviceRetrievalMode = dData.retrieval_mode as string | undefined;

    // Fallback: signal_scout_basics ALWAYS returns retrieval_mode.
    // If discovery_planner didn't propagate it, infer from candidates.
    if (!serviceRetrievalMode) {
      serviceRetrievalMode = rankedCandidates.length > 0 ? "rsshub_live" : "rsshub_live_empty";
    }

    if (rankedCandidates.length > 0) {
      try {
        const { resolveSources } = await import("@/lib/paylabs/sources/source-resolver");
        const normalizedGoal = resolvedBrainData
          ? String((resolvedBrainData as Record<string, unknown>).normalized_goal || "")
          : "";
        const resolverResult = await resolveSources({
          rankedCandidates,
          normalizedGoal,
        });
        if (resolverResult.ok) {
          sourceContext = resolverResult.sourceContext;
          // Propagate retrieval_mode from signal_scout_basics output
          if (serviceRetrievalMode && !sourceContext.retrieval_mode) {
            sourceContext.retrieval_mode = serviceRetrievalMode as import("@/lib/paylabs/sources/types").SourceContext["retrieval_mode"];
          }
        }
      } catch (e: unknown) {
        console.error("[paylabs_source_context] x402 resolve failed", {
          error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      }
    } else if (serviceRetrievalMode) {
      // No candidates but retrieval_mode known — create empty sourceContext
      sourceContext = {
        sources_used: [],
        source_selection_summary: "No matching live RSSHub sources found.",
        source_confidence: 0,
        source_count: 0,
        retrieval_mode: serviceRetrievalMode as import("@/lib/paylabs/sources/types").SourceContext["retrieval_mode"],
      };
    }
  }

  const outResult = buildX402Output(discoveryRunId, effectiveRouteTier, userBudgetUsdc, "completed",
    safeProgressSummaries, paymentGraph, resolvedBrainData || null, macroNodeResults, null, sourceContext, lockedPlan);
  return { ...outResult, _lockedPlan: lockedPlan, _brainLlmDiag: capturedBrainLlmDiag };
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
  sourceContext?: import("@/lib/paylabs/sources/types").SourceContext,
  lockedPlan?: import("@/lib/paylabs/delegated-runtime/types").ExecutionPlan | null,
): OrchestratorOutput {
  const macroNodes = lockedPlan?.selectedMacroNodes
    ?? (TIER_PHASE_MAP[routeTier] || TIER_PHASE_MAP.easy);

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

  // ── Extract creatorDistribution from settlement_memory result ──
  const settlementMemoryResult = macroNodeResults?.["settlement_memory"];
  const settlementMemoryData = settlementMemoryResult
    ? ((settlementMemoryResult.data as Record<string, unknown>) || settlementMemoryResult)
    : null;
  const settlementCreatorDist = settlementMemoryData?.creatorDistribution as Record<string, unknown> | undefined;

  const creatorDistribution: OrchestratorOutput["creatorDistribution"] = settlementCreatorDist
    ? {
        payoutSummary: (settlementCreatorDist.payoutSummary as string) ?? null,
        payoutResults: (settlementCreatorDist.payoutResults as OrchestratorOutput["creatorDistribution"] extends { payoutResults: infer R } ? R : never) ?? [],
        evaluatorOutput: (settlementCreatorDist.evaluatorOutput as Record<string, unknown>) ?? null,
        pendingReserveAtomic: (settlementCreatorDist.pendingReserveAtomic as string) ?? null,
        actualCreatorPaidAtomic: (settlementCreatorDist.actualCreatorPaidAtomic as string) ?? null,
        actualCreatorPaidUsdc: (settlementCreatorDist.actualCreatorPaidUsdc as number) ?? null,
        creatorSplitPlan: (settlementCreatorDist.creatorSplitPlan as Record<string, unknown>) ?? null,
        plannedCreatorPoolAtomic: (settlementCreatorDist.plannedCreatorPoolAtomic as string) ?? null,
        plannedCreatorPayoutCount: (settlementCreatorDist.plannedCreatorPayoutCount as number) ?? null,
        advancedEvaluatorStatus: (settlementCreatorDist.advancedEvaluatorStatus as string) ?? null,
        botShareResult: (settlementCreatorDist.botShareResult as OrchestratorOutput["creatorDistribution"] extends { botShareResult: infer R } ? R : never) ?? null,
        serviceShareResult: (settlementCreatorDist.serviceShareResult as OrchestratorOutput["creatorDistribution"] extends { serviceShareResult: infer R } ? R : never) ?? null,
      }
    : undefined;

  return {
    discoveryRunId,
    status,
    routeTier,
    phasesCompleted: (status === "completed" ? macroNodes : []) as OrchestratorOutput["phasesCompleted"],
    safeProgressSummaries,
    budgetSnapshot: {
      totalBudgetUsdc: userBudgetUsdc,
      spentUsdc: userBudgetUsedUsdc,  // Budget consumed: controller→brain + brain→macro (no child double-count)
      remainingUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      serviceSpend: {} as Record<string, number>,
      settledServiceFeesUsdc: childPaymentVolumeUsdc,  // Actual child service payments only
      estimatedServiceFeesUsdc: 0,
      userBudgetUsdc,
      userBudgetUsedUsdc,
      remainingBudgetUsdc: Math.max(0, userBudgetUsdc - userBudgetUsedUsdc),
      treasuryFeeUsdc: FIXED_FEES_USDC.brainTreasury,
      macroAllocationUsdc: userBudgetUsedUsdc - FIXED_FEES_USDC.brainTreasury,
      childPaymentVolumeUsdc,
      grossPaymentVolumeUsdc: userBudgetUsedUsdc + childPaymentVolumeUsdc,
      executionFeeUsdc: lockedPlan
        ? (lockedPlan.plannedCostBreakdown.brain_treasury_usdc +
           lockedPlan.plannedCostBreakdown.macro_node_fees_usdc +
           lockedPlan.plannedCostBreakdown.service_edge_fees_usdc +
           lockedPlan.plannedCostBreakdown.registry_check_fees_usdc +
           lockedPlan.plannedCostBreakdown.source_access_fees_usdc)
        : undefined,
    },
    consensusDecisions: [],
    paymentPlan,
    paymentEdges: [],
    serviceEvaluations: [],
    brainPlanning: brainData as OrchestratorOutput["brainPlanning"],
    paymentGraph,
    tieredSummaries,
    sourceContext,
    creatorDistribution,
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
  // "auto" defers to Brain's route_tier_hint after planning
  const routeTier = rawTier === "auto"
    ? "auto" as unknown as ExternalRouteTier
    : isValidExternalTier(rawTier)
      ? (rawTier as ExternalRouteTier)
      : DEFAULT_EXTERNAL_TIER;
  const budgetUsdc = Number(body.budget_usdc) || 0.01;

  // ── Retry detection: reuse existing row on paid retry ────
  const customerPaymentSignature =
    req.headers.get("payment-signature") ||
    req.headers.get("x-payment");

  const retryRunId =
    req.nextUrl.searchParams.get("runId") ||
    body.discovery_run_id ||
    body.run_id ||
    null;

  // Fail closed: paid retry MUST include runId from the 402 challenge
  if (customerPaymentSignature && !retryRunId) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_run_id: paid retry must include discovery_run_id/runId from the 402 challenge",
      },
      { status: 400 }
    );
  }

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

  // ── Create or reuse Supabase discovery_run row ───────────
  let discoveryRunId: string;

  if (retryRunId) {
    // Paid retry: reuse existing row, don't create a new one
    const { data: existingRun, error: existingErr } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("id,user_wallet,goal,route_tier,budget_usdc,entry_payment_status")
      .eq("id", retryRunId)
      .single();

    if (existingErr || !existingRun) {
      return NextResponse.json(
        { ok: false, error: "invalid_run_id: discovery run not found" },
        { status: 404 }
      );
    }

    if (existingRun.user_wallet?.toLowerCase() !== userWallet) {
      return NextResponse.json(
        { ok: false, error: "run_wallet_mismatch" },
        { status: 403 }
      );
    }

    discoveryRunId = existingRun.id;
  } else {
    // First request: create new row
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

    discoveryRunId = runRow.id as string;
  }

  // ── x402 orchestration: Brain + macro-node endpoints ────
  // Fail closed: x402 must be enabled for production
  return runX402Path(req, discoveryRunId, goal, userWallet, budgetUsdc, routeTier);
}

// ─── x402 Path ──────────────────────────────────────────────

async function runX402Path(
  req: NextRequest,
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
      // PAYLABS_APP_URL removed — resolvePaylabsAppUrl() prefers
      // PAYLABS_INTERNAL_APP_URL or VERCEL_URL (auto-set by Vercel).
      // We verify URL resolution works below instead of hardcoding one key.
      "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",
      "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",
    ];
    const missingEnvs = requiredEnvs.filter((k) => !process.env[k]);
    if (missingEnvs.length > 0) {
      throw new Error(`config_error: missing required x402 envs: ${missingEnvs.join(", ")}`);
    }

    // Verify URL resolution works (PAYLABS_INTERNAL_APP_URL or VERCEL_URL)
    try {
      resolvePaylabsAppUrl();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`config_error: cannot resolve app URL: ${msg}. Set PAYLABS_INTERNAL_APP_URL or ensure VERCEL_URL is available.`);
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

    // ── Preflight quote: deterministic budget guardrail ──────
    // Compute quote BEFORE any x402 payment. Fail closed if over budget.
    // When tier is "auto", use "easy" for the initial quote — Brain resolves actual tier after payment.
    const quoteTier = routeTier === ("auto" as unknown as ExternalRouteTier) ? "easy" as ExternalRouteTier : routeTier;
    const quote = quoteDelegatedRun({
      routeTier: quoteTier as DelegatedRouteTier,
      userBudgetUsdc: budgetUsdc,
      maxRegistryChecks: 0,
      maxSourceAccesses: 0,
    });

    try {
      assertBudgetOrThrow(quote);
    } catch (budgetErr) {
      const budgetMsg = budgetErr instanceof Error ? budgetErr.message : "budget_exceeded";
      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: budgetMsg.slice(0, 500),
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        {
          ok: false,
          error: budgetMsg,
          quote: {
            routeTier: quote.routeTier,
            plannedCostUsdc: quote.plannedCostUsdc,
            userBudgetUsdc: quote.userBudgetUsdc,
            remainingPlannedBudgetUsdc: quote.remainingPlannedBudgetUsdc,
            budgetStatus: quote.budgetStatus,
            expectedPaymentEdges: quote.expectedPaymentEdges,
          },
        },
        { status: 400 }
      );
    }

    // ── Customer Entry Payment Gate ──────────────────────────
    // Customer (Circle User-Controlled Wallet) must sign ONE x402 entry
    // payment before internal delegated runtime starts.
    //
    // Flow:
    //   1st request (no payment) → 402 + PAYMENT-REQUIRED challenge
    //   2nd request (with payment) → verify + settle → proceed
    //
    // Internal edges remain unchanged (platform DCW wallets).

    const {
      buildCustomerEntryChallenge,
      verifyAndSettleCustomerEntry,
      buildCustomerEntryPaymentData,
    } = await import("@/lib/paylabs/x402/customer-entry-payment");

    const customerPaymentSignature = req.headers.get("payment-signature")
      || req.headers.get("x-payment");

    if (!customerPaymentSignature) {
      // Return HTTP 402 with x402 challenge for customer entry payment
      // Use PUBLIC URL — the browser/customer must be able to reach this host
      const { baseUrl: publicBase } = resolvePublicAppUrl();
      const retryUrl = `${publicBase}/api/paylabs/discovery-runs/inline?runId=${discoveryRunId}&tier=${routeTier}`;
      const { headerValue } = buildCustomerEntryChallenge(
        quote.plannedCostUsdc,
        retryUrl,
      );

      // Store pending entry payment status
      // Merge: preserve existing agent_trace, add entry_payment
      const { data: existingTrace } = await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("agent_trace")
        .eq("id", discoveryRunId)
        .single();
      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          entry_payment_status: "awaiting_payment",
          agent_trace: {
            ...((existingTrace?.agent_trace as Record<string, unknown>) || {}),
            entry_payment: {
              status: "awaiting_payment",
              amount_usdc: quote.plannedCostUsdc,
              tier: routeTier,
            },
          },
        })
        .eq("id", discoveryRunId);

      return new NextResponse(
        JSON.stringify({
          ok: false,
          error: "payment_required",
          discovery_run_id: discoveryRunId,
          retry_url: retryUrl,
          message: `Customer entry payment of ${quote.plannedCostUsdc} USDC required for ${quoteTier} tier`,
          quote: {
            routeTier: quote.routeTier,
            plannedCostUsdc: quote.plannedCostUsdc,
            expectedPaymentEdges: quote.expectedPaymentEdges,
          },
        }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": headerValue,
            "x-payment-required": headerValue,
          },
        }
      );
    }

    // ── Verify + settle customer entry payment ─────────────
    const entryResult = await verifyAndSettleCustomerEntry(
      customerPaymentSignature,
      quote.plannedCostUsdc,
    );

    // Blocker 1: fail closed if payer != userWallet
    // Skip check when Gateway settle doesn't return payer (ARC-TESTNET returns null)
    if (entryResult.ok && entryResult.settled) {
      const payer = entryResult.payer?.toLowerCase();
      const claimedUserWallet = userWallet.toLowerCase();
      if (payer && payer !== claimedUserWallet) {
        await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_summary: `entry_payment_payer_mismatch: expected=${claimedUserWallet} got=${payer}`.slice(0, 500),
            entry_payment_status: "payer_mismatch",
          })
          .eq("id", discoveryRunId);
        return NextResponse.json(
          { ok: false, error: "Entry payment payer does not match claimed user wallet" },
          { status: 403 }
        );
      }
    }

    if (!entryResult.ok || !entryResult.settled) {
      const entryErrorMsg = entryResult.error || "Entry payment verification failed";

      await supabaseAdmin()
        .from("paylabs_discovery_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_summary: `entry_payment_failed: ${entryErrorMsg}`.slice(0, 500),
        })
        .eq("id", discoveryRunId);

      return NextResponse.json(
        {
          ok: false,
          error: `Entry payment failed: ${entryErrorMsg}`,
          entry_payment: {
            status: "failed",
            amount_usdc: quote.plannedCostUsdc,
          },
        },
        { status: 402 }
      );
    }

    // ── Entry payment settled — store safe metadata ─────────
    const entryPaymentData = buildCustomerEntryPaymentData(
      userWallet,
      {
        routeTier: routeTier as DelegatedRouteTier,
        plannedCostUsdc: quote.plannedCostUsdc,
        expectedPaymentEdges: quote.expectedPaymentEdges,
      },
      entryResult,
    );

    // Blocker 3: merge — preserve existing agent_trace, add entry_payment
    const { data: traceBeforeSettle } = await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("agent_trace")
      .eq("id", discoveryRunId)
      .single();

    await supabaseAdmin()
      .from("paylabs_discovery_runs")
      .update({
        customer_wallet_type: entryPaymentData.customer_wallet_type,
        customer_auth_method: entryPaymentData.customer_auth_method ?? null,
        entry_payment_status: entryPaymentData.entry_payment_status,
        entry_payment_amount_usdc: entryPaymentData.entry_payment_amount_usdc,
        entry_payment_tx_hash: entryPaymentData.entry_payment_tx_hash,
        entry_payment_explorer_url: entryPaymentData.entry_payment_explorer_url,
        entry_payment_settlement_id: entryPaymentData.entry_payment_settlement_id ?? null,
        entry_payment_batch_tx_hash: entryPaymentData.entry_payment_batch_tx_hash ?? null,
        entry_payment_batch_explorer_url: entryPaymentData.entry_payment_batch_explorer_url ?? null,
        agent_trace: {
          ...((traceBeforeSettle?.agent_trace as Record<string, unknown>) || {}),
          entry_payment: {
            status: entryPaymentData.entry_payment_status,
            amount_usdc: entryPaymentData.entry_payment_amount_usdc,
            tx_hash: entryPaymentData.entry_payment_tx_hash,
            explorer_url: entryPaymentData.entry_payment_explorer_url,
            settlement_id: entryPaymentData.entry_payment_settlement_id ?? null,
            settlement_url: entryPaymentData.entry_payment_settlement_url ?? null,
            batch_tx_hash: entryPaymentData.entry_payment_batch_tx_hash ?? null,
            batch_explorer_url: entryPaymentData.entry_payment_batch_explorer_url ?? null,
            batch_resolver_url: entryPaymentData.entry_payment_batch_resolver_url ?? null,
            customer_wallet_type: entryPaymentData.customer_wallet_type,
            tier: entryPaymentData.selected_tier,
            planned_cost_usdc: entryPaymentData.quote_planned_cost_usdc,
            expected_payment_edges: entryPaymentData.quote_expected_payment_edges,
            payer: entryResult.payer ?? null,
          },
        },
      })
      .eq("id", discoveryRunId);

    // ── Run internal delegated runtime (entry payment verified) ──
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
                route_tier_hint: result.brainPlanning.route_tier_hint,
                safe_summary: result.brainPlanning.safe_brain_summary,
                assistant_response: result.brainPlanning.assistant_response,
                user_visible_reasoning: result.brainPlanning.user_visible_reasoning,
                tier_decision_reason: result.brainPlanning.tier_decision_reason,
                plan_rationale: result.brainPlanning.plan_rationale,
                selected_macro_nodes: result.brainPlanning.selected_macro_nodes,
                selected_services: result.brainPlanning.selected_services,
                planned_cost_usdc: result.brainPlanning.planned_cost_usdc,
              }
            : result.error
              ? { route_tier_hint: null, error: result.error.slice(0, 200) }
              : null,
          payment_graph: result.paymentGraph.map((e) => ({
            buyer: e.buyer,
            seller: e.seller,
            node_type: e.nodeType,
            status: e.status,
            tx_hash: e.txHash ?? null,
            explorer_url: e.explorerUrl ?? null,
            settlement_id: e.settlementId ?? null,
            settlement_url: e.settlementUrl ?? null,
            batch_tx_hash: e.batchTxHash ?? null,
            batch_explorer_url: e.batchExplorerUrl ?? null,
            batch_resolver_url: e.batchResolverUrl ?? null,
            gateway_accepted: e.gatewayAccepted ?? (e.status === "paid"),
            transfer_status: e.transferStatus ?? null,
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

    // ── Build source context (PR #26) ──
    // x402 path: sourceContext already resolved from macroNodeResults in runX402Orchestration
    // Non-x402 path: build from OrchestratorOutput serviceEvaluations
    let sourceContextError: string | null = null;
    try {
      if (result.sourceContext) {
        exitOutput.sources_used = result.sourceContext.sources_used;
        exitOutput.source_selection_summary = result.sourceContext.source_selection_summary;
        exitOutput.source_confidence = result.sourceContext.source_confidence;
        exitOutput.source_count = result.sourceContext.source_count;
        exitOutput.source_retrieval_mode = result.sourceContext.retrieval_mode;
      } else {
        const { buildSourceContextFromResult } = await import("@/lib/paylabs/sources/source-context");
        const sourceCtx = await buildSourceContextFromResult(result);
        if (sourceCtx) {
          exitOutput.sources_used = sourceCtx.sources_used;
          exitOutput.source_selection_summary = sourceCtx.source_selection_summary;
          exitOutput.source_confidence = sourceCtx.source_confidence;
          exitOutput.source_count = sourceCtx.source_count;
          exitOutput.source_retrieval_mode = sourceCtx.retrieval_mode;
        }
      }
    } catch (e: unknown) {
      sourceContextError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      console.error("[paylabs_source_context] build failed", { discoveryRunId, error: sourceContextError });
    }

    // ── V3: Build source-grounded final_answer ──
    let finalAnswer: string | null = null;
    try {
      const { buildSourceGroundedFinalAnswer } = await import("@/lib/paylabs/sources/source-final-answer");
      const sourcesUsed = exitOutput.sources_used || [];
      finalAnswer = buildSourceGroundedFinalAnswer({
        goal,
        sourcesUsed,
        sourceConfidence: exitOutput.source_confidence || 0,
        retrievalMode: exitOutput.source_retrieval_mode || (sourcesUsed.length > 0
          ? (sourcesUsed.some((s) => s.source_kind === "rsshub_live") ? "rsshub_live" : "db_fallback")
          : "none"),
      });
    } catch (e: unknown) {
      console.error("[paylabs_final_answer] build failed", {
        error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
      });
    }

    // ── V3: Store source_context snapshot in agent_trace (MERGE, not overwrite) ──
    // Always store if we have a retrieval_mode, even when sources are empty (rsshub_live_empty)
    if (exitOutput.source_retrieval_mode || (exitOutput.sources_used && exitOutput.sources_used.length > 0)) {
      try {
        // Read existing agent_trace to preserve brain_planning, payment_graph, etc.
        const { data: existingRun } = await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .select("agent_trace")
          .eq("id", discoveryRunId)
          .single();
        const existingTrace = (existingRun?.agent_trace as Record<string, unknown>) || {};

        await supabaseAdmin()
          .from("paylabs_discovery_runs")
          .update({
            agent_trace: {
              ...existingTrace,
              source_context: {
                source_count: exitOutput.source_count || 0,
                source_confidence: exitOutput.source_confidence || 0,
                retrieval_mode: exitOutput.source_retrieval_mode || "rsshub_live_empty",
                sources_used: (exitOutput.sources_used || []).slice(0, 20).map((s) => ({
                  title: s.title,
                  url: s.url,
                  domain: s.domain,
                  rank: s.rank,
                  source_kind: s.source_kind,
                  provider: s.provider,
                })),
              },
              final_answer: finalAnswer,
            },
          })
          .eq("id", discoveryRunId);
      } catch (e: unknown) {
        console.error("[paylabs_source_snapshot] store failed", {
          error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
        });
      }
    }

    // ── Write canonical x402 visibility (events + receipt) ──
    let visibilityError: string | null = null;
    try {
      const { writePayLabsVisibility } = await import("@/lib/paylabs/visibility/writer");
      await writePayLabsVisibility({
        discoveryRunId,
        userWallet,
        routeTier: result.routeTier,
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
      final_answer: finalAnswer,
      discovery_run_id: discoveryRunId,
      status: result.status,
      requested_route_tier: routeTier,
      route_tier: result._lockedPlan ? result.routeTier : (result.status === "failed" ? null : result.routeTier),
      effective_route_tier: result._lockedPlan ? result.routeTier : (result.status === "failed" ? null : result.routeTier),
      brain_route_tier_hint: result.brainPlanning?.route_tier_hint ?? null,
      _brain_diag: result._brainLlmDiag
        ? {
            error_code: (result._brainLlmDiag as Record<string, unknown>).error_code ?? null,
            error_safe: (result._brainLlmDiag as Record<string, unknown>).error_safe ?? null,
            provider: (result._brainLlmDiag as Record<string, unknown>).provider ?? "unknown",
            model: (result._brainLlmDiag as Record<string, unknown>).model ?? "unknown",
            agent_name: (result._brainLlmDiag as Record<string, unknown>).agent_name ?? "unknown",
            mode: (result._brainLlmDiag as Record<string, unknown>).mode ?? "unknown",
            max_tokens: (result._brainLlmDiag as Record<string, unknown>).max_tokens ?? null,
            timeout_ms: (result._brainLlmDiag as Record<string, unknown>).timeout_ms ?? null,
            streaming: (result._brainLlmDiag as Record<string, unknown>).streaming ?? null,
            force_non_streaming_body: (result._brainLlmDiag as Record<string, unknown>).force_non_streaming_body ?? null,
            json_found: (result._brainLlmDiag as Record<string, unknown>).json_found ?? null,
            parse_ok: (result._brainLlmDiag as Record<string, unknown>).parse_ok ?? null,
            validation_ok: (result._brainLlmDiag as Record<string, unknown>).validation_ok ?? null,
            received_keys: (result._brainLlmDiag as Record<string, unknown>).received_keys ?? null,
            expected_keys: (result._brainLlmDiag as Record<string, unknown>).expected_keys ?? null,
            validation_issue_paths: (result._brainLlmDiag as Record<string, unknown>).validation_issue_paths ?? null,
            content_type: (result._brainLlmDiag as Record<string, unknown>).content_type ?? null,
            content_length: (result._brainLlmDiag as Record<string, unknown>).content_length ?? null,
            safe_error: ((result._brainLlmDiag as Record<string, unknown>).error_safe as string)?.slice(0, 220) ?? null,
          }
        : {
            error_code: null,
            error_safe: null,
            provider: "unknown",
            model: "unknown",
            agent_name: "unknown",
            mode: "unknown",
            max_tokens: null,
            timeout_ms: null,
            streaming: null,
            force_non_streaming_body: null,
            json_found: null,
            parse_ok: null,
            validation_ok: null,
            received_keys: null,
            expected_keys: null,
            validation_issue_paths: null,
            content_type: null,
            content_length: null,
            safe_error: null,
          },
      locked_execution_plan: result._lockedPlan
        ? {
            selected_macro_nodes: result._lockedPlan.selectedMacroNodes,
            selected_services: result._lockedPlan.selectedServices,
            planned_cost_usdc: result._lockedPlan.plannedCostUsdc,
            planned_cost_breakdown: result._lockedPlan.plannedCostBreakdown,
            locked: true,
            source: "brain_planner_validated",
            _diag_raw_services: result._lockedPlan.selectedServices,
            _diag_effective_tier: result.routeTier,
          }
        : null,
      execution_origin: "vercel_inline",
      execution_mode: "x402_orchestration",
      worker_used: false,
      x402_enabled: true,
      phases_completed: result.phasesCompleted,
      brain_planning: result.brainPlanning
        ? {
            route_tier_hint: result.brainPlanning.route_tier_hint,
            error: ((result.brainPlanning as unknown as Record<string, unknown>).error as string) ?? null,
            safe_summary: result.brainPlanning.safe_brain_summary,
            assistant_response: result.brainPlanning.assistant_response,
            user_visible_reasoning: result.brainPlanning.user_visible_reasoning,
            tier_decision_reason: result.brainPlanning.tier_decision_reason,
            plan_rationale: result.brainPlanning.plan_rationale,
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
        settlement_id: e.settlementId ?? null,
        settlement_url: e.settlementUrl ?? null,
        batch_tx_hash: e.batchTxHash ?? null,
        batch_explorer_url: e.batchExplorerUrl ?? null,
        batch_resolver_url: e.batchResolverUrl ?? null,
        gateway_accepted: e.gatewayAccepted ?? (e.status === "paid"),
        transfer_status: e.transferStatus ?? null,
        error: e.error ?? null,
        mode: e.mode ?? null,
      })),
      safe_progress_summaries: result.safeProgressSummaries,
      budget_snapshot: result.budgetSnapshot,
      tiered_summaries: result.tieredSummaries,
      exit_output: exitOutput,
      source_context: exitOutput.sources_used ? {
        sources_used: exitOutput.sources_used,
        source_selection_summary: exitOutput.source_selection_summary,
        source_confidence: exitOutput.source_confidence,
        source_count: exitOutput.source_count,
        retrieval_mode: exitOutput.source_retrieval_mode || null,
      } : null,
      source_context_error: sourceContextError,
      quote: {
        routeTier: quote.routeTier,
        expectedPaymentEdges: quote.expectedPaymentEdges,
        plannedCostUsdc: quote.plannedCostUsdc,
        userBudgetUsdc: quote.userBudgetUsdc,
        remainingPlannedBudgetUsdc: quote.remainingPlannedBudgetUsdc,
        budgetStatus: quote.budgetStatus,
        macroNodeFeesUsdc: quote.macroNodeFeesUsdc,
        serviceEdgeFeesUsdc: quote.serviceEdgeFeesUsdc,
        registryCheckFeesUsdc: quote.registryCheckFeesUsdc,
        sourceAccessFeesUsdc: quote.sourceAccessFeesUsdc,
        locked: quote.locked,
      },
      receipt_ready: exitOutput.receipt_ready && !visibilityError,
      settled: fullySettled,
      mode: fullySettled ? "x402" : "x402_failed",
      entry_payment: {
        status: "paid",
        amount_usdc: quote.plannedCostUsdc,
        tx_hash: entryResult.paymentMeta?.txHash ?? null,
        explorer_url: entryResult.paymentMeta?.explorerUrl ?? null,
        settlement_id: entryResult.paymentMeta?.settlementId ?? entryPaymentData.entry_payment_settlement_id ?? null,
        settlement_url: entryResult.paymentMeta?.settlementUrl ?? entryPaymentData.entry_payment_settlement_url ?? null,
        batch_tx_hash: entryResult.paymentMeta?.batchTxHash ?? null,
        batch_explorer_url: entryResult.paymentMeta?.batchExplorerUrl ?? null,
        batch_resolver_url: entryResult.paymentMeta?.batchResolverUrl ?? entryPaymentData.entry_payment_batch_resolver_url ?? null,
        gateway_accepted: entryResult.paymentMeta?.gatewayAccepted ?? true,
        transfer_status: entryResult.paymentMeta?.transferStatus ?? null,
        customer_wallet: userWallet,
        customer_wallet_type: entryPaymentData.customer_wallet_type,
      },
      entry_payment_explorer_url: entryPaymentData.entry_payment_explorer_url ?? null,
      entry_payment_batch_explorer_url: entryPaymentData.entry_payment_batch_explorer_url ?? null,
      entry_payment_settlement_id: entryPaymentData.entry_payment_settlement_id ?? entryResult.paymentMeta?.settlementId ?? null,
      entry_payment_batch_resolver_url: entryPaymentData.entry_payment_batch_resolver_url ?? entryResult.paymentMeta?.batchResolverUrl ?? null,
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


