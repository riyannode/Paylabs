/**
 * Locked Orchestration — Execute macro-nodes with pre-locked plan.
 *
 * This module does not call Brain directly; Brain x402 is completed
 * during route-preflight. Uses locked tier + plan from route-preflight.
 * Called by execute-locked endpoint after final entry payment settles.
 *
 * Does NOT:
 * - Call Brain x402 (Brain already ran during preflight)
 * - Re-resolve tier (locked in agent_trace.auto_tier_preflight)
 * - Re-lock execution plan (locked in agent_trace.auto_tier_preflight)
 *
 * Payment graph accounting:
 * - Brain x402 occurs during route-preflight. Canonical payment graph includes
 *   controller → brain → macro-node → child service edges.
 * - User Cost = routing_fee + final_entry_payment (stored separately).
 * - Platform x402 Volume = internal macro/service graph only.
 */

import type {
  DelegatedRouteTier,
  ExecutionPlan,
  OrchestratorOutput,
  PaymentGraphEdge,
  MacroNodePhase,
  ServiceName,
} from "./types";
import type { DcwSigner } from "@/lib/paylabs/x402/buyer-transport";
import { getMacroNodeAllocationUsdcForTier } from "./node-registry";
import {
  SERVICE_MACRO_MAP,
  TIER_SERVICE_PRESETS,
  FIXED_FEES_USDC,
} from "./quote-engine";
import { randomUUID } from "node:crypto";
import {
  createSourceResolutionDiagnostic,
  resolveDiagnosticScenario,
  type SourceResolutionDiagnostic,
} from "./source-resolution-diagnostic";

// ─── Types ───────────────────────────────────────────────────

export interface X402CallResult {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  paymentMetadata?: {
    txHash?: string | null;
    explorerUrl?: string | null;
  } | null;
}

export interface LockedOrchestrationParams {
  discoveryRunId: string;
  userGoal: string;
  userWallet: string;
  userBudgetUsdc: number;
  lockedTier: DelegatedRouteTier;
  lockedPlan: ExecutionPlan;
  brainData: Record<string, unknown>;
  dcwSigner: DcwSigner;
  /** Injected: call a macro-node endpoint via x402 */
  callMacroNode: (
    signer: DcwSigner,
    nodeName: string,
    body: {
      discoveryRunId: string;
      userGoal: string;
      routeTier: string;
      userBudgetUsdc: number;
      userWallet: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<X402CallResult>;
  /** Injected: build OrchestratorOutput from raw data */
  buildOutput: (
    discoveryRunId: string,
    routeTier: DelegatedRouteTier,
    userBudgetUsdc: number,
    status: "completed" | "failed",
    summaries: string[],
    graph: PaymentGraphEdge[],
    brainData: Record<string, unknown> | null,
    macroResults: Record<string, Record<string, unknown>> | null,
    error: string | null,
    sourceContext?: import("../sources/types").SourceContext,
    lockedPlan?: ExecutionPlan | null,
  ) => OrchestratorOutput;
}

export interface LockedOrchestrationResult {
  output: OrchestratorOutput;
  _lockedPlan: ExecutionPlan;
  _sourceResolutionDiagnostic?: SourceResolutionDiagnostic;
}

// ─── Reconstruct ExecutionPlan from preflight trace ──────────

/**
 * Reconstruct a full ExecutionPlan from stored agent_trace.auto_tier_preflight.
 *
 * PR76 trace stores: selected_tier, locked_selected_macro_nodes,
 * locked_selected_services, locked_planned_cost_usdc,
 * locked_planned_cost_breakdown — but NOT servicesByMacroNode.
 *
 * We reconstruct servicesByMacroNode from SERVICE_MACRO_MAP.
 */
export function reconstructLockedPlan(preflight: {
  selected_tier: string;
  locked_selected_macro_nodes: string[];
  locked_selected_services: string[];
  locked_planned_cost_usdc: number;
  locked_planned_cost_breakdown: {
    brain_treasury_usdc: number;
    macro_node_fees_usdc: number;
    service_edge_fees_usdc: number;
    registry_check_fees_usdc: number;
    source_access_fees_usdc: number;
  };
}): ExecutionPlan {
  const selectedMacroNodes = preflight.locked_selected_macro_nodes as MacroNodePhase[];
  const selectedServices = preflight.locked_selected_services as ServiceName[];

  // Reconstruct servicesByMacroNode from SERVICE_MACRO_MAP
  const servicesByMacroNode: Record<MacroNodePhase, ServiceName[]> = {
    discovery_planner: [],
    payment_decision: [],
    settlement_memory: [],
  };
  for (const service of selectedServices) {
    const macroNode = SERVICE_MACRO_MAP[service];
    if (macroNode) {
      servicesByMacroNode[macroNode].push(service);
    }
  }

  return {
    selectedMacroNodes,
    selectedServices,
    servicesByMacroNode,
    plannedCostUsdc: preflight.locked_planned_cost_usdc,
    plannedCostBreakdown: preflight.locked_planned_cost_breakdown,
    locked: true,
  };
}

// ─── Main Function ───────────────────────────────────────────

/**
 * Execute macro-nodes with a pre-locked plan (no Brain x402).
 *
 * Same macro-node loop + source context resolution as inline/route.ts,
 * but uses locked plan from preflight. Brain x402 was settled during route-preflight.
 */
export async function executeLockedMacroNodePipeline(
  params: LockedOrchestrationParams,
): Promise<LockedOrchestrationResult> {
  const {
    discoveryRunId,
    userGoal,
    userWallet,
    userBudgetUsdc,
    lockedTier,
    lockedPlan,
    brainData,
    dcwSigner,
    callMacroNode,
    buildOutput,
  } = params;

  const safeProgressSummaries: string[] = [];
  const paymentGraph: PaymentGraphEdge[] = [];
  const macroNodes = lockedPlan.selectedMacroNodes;

  safeProgressSummaries.push(
    `Locked orchestration started: tier=${lockedTier}, ` +
      `macroNodes=${macroNodes.length}, budget=${userBudgetUsdc} USDC`,
  );

  // ── Macro-node loop (mirrors inline/route.ts lines 425-541) ──
  const macroNodeResults: Record<string, Record<string, unknown>> = {};

  for (const node of macroNodes) {
    let payload: Record<string, unknown> = {};

    if (node === "discovery_planner") {
      // Use brain_fields from preflight (same shape as Brain response)
      if (brainData) {
        payload = {
          brain_normalized_goal: brainData.normalized_goal || null,
          brain_discovery_strategy: brainData.discovery_strategy || null,
          brain_suggested_query_variants:
            brainData.suggested_query_variants || [],
          brain_safe_summary: brainData.safe_brain_summary || null,
        };
      }
    } else if (node === "payment_decision") {
      const prev = macroNodeResults["discovery_planner"];
      if (prev) {
        const d = (prev.data as Record<string, unknown>) || prev;
        payload = {
          ranked_candidates:
            (d.rankedCandidates as unknown[]) ||
            (d.ranked_candidates as unknown[]) ||
            [],
        };
      }
    } else if (node === "settlement_memory") {
      const prev = macroNodeResults["payment_decision"];
      if (prev) {
        const d = (prev.data as Record<string, unknown>) || prev;
        payload = {
          approved_items:
            (d.approvedItems as unknown[]) ||
            (d.approved_items as unknown[]) ||
            [],
          skipped_items:
            (d.skippedItems as unknown[]) ||
            (d.skipped_items as unknown[]) ||
            [],
        };
      }
    }

    safeProgressSummaries.push(
      `Calling macro-node ${node} (x402 locked)...`,
    );

    const nodeResult = await callMacroNode(dcwSigner, node, {
      discoveryRunId,
      userGoal,
      routeTier: lockedTier,
      userBudgetUsdc,
      userWallet,
      payload,
    });

    if (!nodeResult.ok || !nodeResult.data) {
      paymentGraph.push({
        edgeId: randomUUID(),
        buyer: "brain",
        seller: node,
        amountUsdc: getMacroNodeAllocationUsdcForTier(
          node as MacroNodePhase,
          lockedTier,
        ),
        status: "skipped",
        nodeType: "macro_node",
        paymentRef: null,
      });
      const failOutput = buildOutput(
        discoveryRunId,
        lockedTier,
        userBudgetUsdc,
        "failed",
        [
          ...safeProgressSummaries,
          `FAILED: Macro-node ${node}: ${nodeResult.error}`,
        ],
        paymentGraph,
        brainData,
        macroNodeResults,
        `Macro-node ${node} x402 failed: ${nodeResult.error}`,
        undefined,
        lockedPlan,
      );
      return { output: failOutput, _lockedPlan: lockedPlan };
    }

    // Record brain → macro-node edge (macro allocation payment)
    paymentGraph.push({
      edgeId: randomUUID(),
      buyer: "brain",
      seller: node,
      amountUsdc: getMacroNodeAllocationUsdcForTier(
        node as MacroNodePhase,
        lockedTier,
      ),
      status: "paid",
      nodeType: "macro_node",
      paymentRef: null,
      txHash: nodeResult.paymentMetadata?.txHash ?? null,
      explorerUrl: nodeResult.paymentMetadata?.explorerUrl ?? null,
    });

    macroNodeResults[node] = nodeResult.data;

    // Extract child service payment edges from macro-node serviceEvaluations
    const childEvals = nodeResult.data.serviceEvaluations as Array<{
      serviceName: string;
      status: string;
      settled: boolean;
      mode: string;
      costUsdc: number;
      txHash?: string | null;
      explorerUrl?: string | null;
      error?: string | null;
    }> | undefined;

    if (childEvals) {
      for (const ev of childEvals) {
        paymentGraph.push({
          edgeId: randomUUID(),
          buyer: node,
          seller: ev.serviceName,
          amountUsdc: ev.costUsdc || 0.000001,
          status: ev.settled
            ? "paid"
            : ev.status === "failed"
              ? "failed"
              : "skipped",
          nodeType: "service",
          paymentRef: null,
          txHash: ev.txHash ?? null,
          explorerUrl: ev.explorerUrl ?? null,
          error: ev.error ?? null,
          mode: ev.mode,
        });
      }
    }

    // Progress summary per node
    const runnerData =
      (nodeResult.data.data as Record<string, unknown>) || nodeResult.data;
    if (node === "discovery_planner") {
      const candidates =
        (runnerData.rankedCandidates as unknown[]) ||
        (runnerData.ranked_candidates as unknown[]) ||
        [];
      safeProgressSummaries.push(
        `Discovery planner: ${candidates.length} candidates`,
      );
    } else if (node === "payment_decision") {
      const approved =
        (runnerData.approvedItems as unknown[]) ||
        (runnerData.approved_items as unknown[]) ||
        [];
      safeProgressSummaries.push(
        `Payment decision: ${approved.length} approved`,
      );
    } else if (node === "settlement_memory") {
      const routed =
        (runnerData.routedItems as unknown[]) ||
        (runnerData.routed_items as unknown[]) ||
        [];
      safeProgressSummaries.push(
        `Settlement: ${routed.length} items routed`,
      );
    }
  }

  safeProgressSummaries.push(
    "Locked orchestration completed: all phases settled",
  );

  // ── Source context resolution (mirrors inline/route.ts lines 545-616) ──
  // ── Diagnostic: trace source resolution for each checkpoint ──
  const srcDiag = createSourceResolutionDiagnostic();
  let sourceContext: import("../sources/types").SourceContext | undefined;
  let serviceRetrievalMode: string | undefined;
  const discoveryMacroResult = macroNodeResults["discovery_planner"];

  if (discoveryMacroResult) {
    const dData =
      (discoveryMacroResult.data as Record<string, unknown>) ||
      discoveryMacroResult;
    const rankedCandidates =
      (dData.rankedCandidates as Array<{
        feed_item_id: string;
        rank: number;
        relevance_score: number;
      }>) ||
      (dData.ranked_candidates as Array<{
        feed_item_id: string;
        rank: number;
        relevance_score: number;
      }>) ||
      [];

    // ── Diagnostic checkpoint 3: locked-orchestration extraction ──
    srcDiag.locked_orchestration_ranked_candidates_count = rankedCandidates.length;
    srcDiag.ranked_candidates_have_url_count = rankedCandidates.filter(
      (c) => !!(c as Record<string, unknown>).source_url
    ).length;
    srcDiag.ranked_candidates_have_feed_item_id_count = rankedCandidates.filter(
      (c) => !!c.feed_item_id
    ).length;

    // ── Diagnostic checkpoint 2: discovery_planner output ──
    // Also check serviceEvaluations for the signal_scout output
    const serviceEvals = dData.serviceEvaluations as Array<{
      serviceName: string;
      output?: Record<string, unknown>;
      status?: string;
    }> | undefined;
    if (serviceEvals) {
      const signalEval = serviceEvals.find(
        (e) => (e.serviceName === "signal_scout" || e.serviceName === "signal_scout_basics") && e.output
      );
      if (signalEval?.output) {
        const signalCandidates = (signalEval.output.ranked_candidates as unknown[]) || [];
        srcDiag.signal_scout_ranked_candidates_count = signalCandidates.length;
      }
      // Extract live diagnostics from signal_scout if available
      const signalOutput = serviceEvals.find(
        (e) => (e.serviceName === "signal_scout" || e.serviceName === "signal_scout_basics")
      )?.output as Record<string, unknown> | undefined;
      if (signalOutput) {
        const liveDiag = signalOutput.live_diagnostics as Record<string, unknown> | undefined;
        if (liveDiag) {
          srcDiag.rsshub_routes_fetched_count = (liveDiag.fetched_routes as number) || 0;
          srcDiag.topic_routes_attempted = (liveDiag.topic_routes_count as number) || 0;
          // route_candidates ≈ resolved routes
          srcDiag.topic_routes_success_count = (liveDiag.resolved_routes as number) || 0;
        }
        // Extract topic candidates count from signal output
        const topicCount = signalOutput.topic_candidates_count as number | undefined;
        if (topicCount !== undefined) {
          srcDiag.live_items_after_validation_count = topicCount;
        }
        srcDiag.retrieval_mode = (signalOutput.retrieval_mode as string) || null;
      }
      // Extract entity_terms and expanded_queries from query_builder output
      const qbEval = serviceEvals.find(
        (e) => e.serviceName === "query_builder" && e.output
      );
      if (qbEval?.output) {
        srcDiag.entity_terms_count = ((qbEval.output.entity_terms as string[]) || []).length;
        srcDiag.expanded_queries = (qbEval.output.expanded_queries as string[]) || [];
      }
    }

    // discovery_planner output = rankedCandidates (already extracted above)
    srcDiag.discovery_planner_ranked_candidates_count = rankedCandidates.length;

    serviceRetrievalMode = dData.retrieval_mode as string | undefined;
    if (!serviceRetrievalMode) {
      serviceRetrievalMode =
        rankedCandidates.length > 0 ? "rsshub_live" : "rsshub_live_empty";
    }

    if (rankedCandidates.length > 0) {
      try {
        const { resolveSources } = await import("../sources/source-resolver");
        const normalizedGoal = brainData
          ? String(brainData.normalized_goal || "")
          : "";

        let entityTerms =
          (dData.entityTerms as string[]) ||
          (dData.entity_terms as string[]) ||
          [];
        if (entityTerms.length === 0) {
          const childEvals = dData.serviceEvaluations as Array<{
            serviceName: string;
            output?: Record<string, unknown>;
          }> | undefined;
          if (childEvals) {
            const qbEval = childEvals.find(
              (e) => e.serviceName === "query_builder" && e.output,
            );
            if (qbEval?.output) {
              entityTerms =
                (qbEval.output.entity_terms as string[]) ||
                (qbEval.output.entityTerms as string[]) ||
                [];
            }
          }
        }

        // ── Diagnostic: entity terms from resolver input ──
        if (srcDiag.entity_terms_count === 0) {
          srcDiag.entity_terms_count = entityTerms.length;
        }

        // ── Diagnostic checkpoint 4: resolveSources call ──
        srcDiag.resolve_sources_called = true;

        const resolverResult = await resolveSources({
          rankedCandidates,
          normalizedGoal,
          entityTerms,
        });

        srcDiag.resolve_sources_ok = resolverResult.ok;
        srcDiag.resolver_sources_used_count = resolverResult.sourceContext?.sources_used?.length ?? 0;

        if (resolverResult.ok) {
          sourceContext = resolverResult.sourceContext;
          if (serviceRetrievalMode && !sourceContext.retrieval_mode) {
            sourceContext.retrieval_mode =
              serviceRetrievalMode as import("../sources/types").SourceContext["retrieval_mode"];
          }
        } else {
          srcDiag.resolve_sources_error_safe = resolverResult.error?.slice(0, 200) || "unknown";
        }
      } catch (e: unknown) {
        srcDiag.resolve_sources_called = true;
        srcDiag.resolve_sources_ok = false;
        srcDiag.resolve_sources_error_safe =
          e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        console.error("[locked_orchestration] source resolve failed", {
          error:
            e instanceof Error
              ? e.message.slice(0, 200)
              : String(e).slice(0, 200),
        });
      }
    } else if (serviceRetrievalMode) {
      sourceContext = {
        sources_used: [],
        source_selection_summary: "No matching live RSSHub sources found.",
        source_confidence: 0,
        source_count: 0,
        retrieval_mode:
          serviceRetrievalMode as import("../sources/types").SourceContext["retrieval_mode"],
      };
    }
  }

  // ── Diagnostic checkpoint 5: final source context ──
  srcDiag.final_source_context_count = sourceContext?.sources_used?.length ?? 0;
  srcDiag.detected_topic = brainData
    ? String(brainData.normalized_goal || "").slice(0, 100)
    : null;

  // ── Diagnostic: resolve scenario ──
  srcDiag.scenario = resolveDiagnosticScenario(srcDiag);

  console.log(JSON.stringify({
    log: "[source_resolution_diagnostic]",
    scenario: srcDiag.scenario,
    rsshub_routes_fetched: srcDiag.rsshub_routes_fetched_count,
    signal_scout_ranked: srcDiag.signal_scout_ranked_candidates_count,
    discovery_planner_ranked: srcDiag.discovery_planner_ranked_candidates_count,
    locked_orchestration_ranked: srcDiag.locked_orchestration_ranked_candidates_count,
    resolver_sources_used: srcDiag.resolver_sources_used_count,
    final_source_context: srcDiag.final_source_context_count,
  }));

  // ── Build output ──
  const output = buildOutput(
    discoveryRunId,
    lockedTier,
    userBudgetUsdc,
    "completed",
    safeProgressSummaries,
    paymentGraph,
    brainData,
    macroNodeResults,
    null,
    sourceContext,
    lockedPlan,
  );

  return { output, _lockedPlan: lockedPlan, _sourceResolutionDiagnostic: srcDiag };
}
