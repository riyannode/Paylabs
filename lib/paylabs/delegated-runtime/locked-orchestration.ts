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
  extractQueryRequirements,
  getRequestedAspectKeys,
  projectRequiredSubjects,
} from "../sources/query-requirements";

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
  /** Internal RAG evidence result — not exposed publicly */
  _ragEvidence?: import("../rag/types").EvidenceRetrievalResult;
  /** Internal RAG evidence pack — coverage-aware selection for synthesis */
  _ragEvidencePack?: import("../rag/types").EvidencePack;
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
  let sourceContext: import("../sources/types").SourceContext | undefined;
  let serviceRetrievalMode: string | undefined;
  let retrievalContextForEvidence: import("../sources/types").RetrievalContext | undefined;
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

    serviceRetrievalMode = dData.retrieval_mode as string | undefined;
    if (!serviceRetrievalMode) {
      serviceRetrievalMode =
        rankedCandidates.length > 0 ? "rsshub_live" : "rsshub_live_empty";
    }

    if (rankedCandidates.length > 0) {
      try {
        const { resolveSources } = await import("../sources/source-resolver");

        // Use canonical retrievalContext from Discovery Planner output.
        // This is the single source of truth for retrieval parameters.
        const retrievalContext = dData.retrievalContext as import("../sources/types").RetrievalContext | undefined;

        // Capture for evidence retrieval (used after source resolution)
        retrievalContextForEvidence = retrievalContext;

        // Backward compat: extract from serviceEvaluations if retrievalContext missing
        if (!retrievalContext) {
          const childEvals = dData.serviceEvaluations as Array<{
            serviceName: string;
            output?: Record<string, unknown>;
          }> | undefined;
          if (childEvals) {
            const qbEval = childEvals.find(
              (e) => e.serviceName === "query_builder" && e.output,
            );
            if (qbEval?.output) {
              // Build a retrievalContext from QB output as fallback
              const queryRequirements = extractQueryRequirements(userGoal);
              const primaryEntities = projectRequiredSubjects(queryRequirements);
              const requestedAspects = getRequestedAspectKeys(queryRequirements);
              const rcFallback: import("../sources/types").RetrievalContext = {
                originalGoal: userGoal,
                normalizedGoal: String(brainData?.normalized_goal || userGoal),
                intentType: "unknown",
                primaryEntities,
                secondaryEntities: (qbEval.output.secondary_entities as import("../sources/types").RetrievalContext["secondaryEntities"]) || [],
                lockedPhrases: (qbEval.output.locked_phrases as string[]) || [],
                negativeEntities: (qbEval.output.negative_entities as string[]) || [],
                topics: (qbEval.output.topics as string[]) || [],
                requestedAspects,
                queryRequirements,
                entityTerms: (qbEval.output.entity_terms as string[]) || [],
                expandedQueries: (qbEval.output.expanded_queries as string[]) || [],
                negativeFilters: (qbEval.output.negative_filters as string[]) || [],
                sourcePreferences: (qbEval.output.source_preferences as string[]) || [],
              };
              (dData as Record<string, unknown>).retrievalContext = rcFallback;
            }
          }
        }

        if (!(dData as Record<string, unknown>).retrievalContext) {
          const queryRequirements = extractQueryRequirements(userGoal);
          const primaryEntities = projectRequiredSubjects(queryRequirements);
          const requestedAspects = getRequestedAspectKeys(queryRequirements);
          (dData as Record<string, unknown>).retrievalContext = {
            originalGoal: userGoal,
            normalizedGoal: String(brainData?.normalized_goal || userGoal),
            intentType: "unknown",
            primaryEntities,
            secondaryEntities: [],
            lockedPhrases: [],
            negativeEntities: [],
            topics: [],
            requestedAspects,
            queryRequirements,
            entityTerms: primaryEntities.flatMap((entity) => [entity.canonical, entity.text]).slice(0, 15),
            expandedQueries: [],
            negativeFilters: [],
            sourcePreferences: [],
          } satisfies import("../sources/types").RetrievalContext;
        }

        const rc = dData.retrievalContext as import("../sources/types").RetrievalContext | undefined;
        // After canonical rc is resolved, capture for evidence retrieval (item 8)
        // This ensures fallback runs also get the correct retrieval context
        if (rc) retrievalContextForEvidence = rc;
        const resolvedNormalizedGoal = rc?.normalizedGoal
          || (brainData ? String(brainData.normalized_goal || "") : "");

        const resolverResult = await resolveSources({
          rankedCandidates,
          retrievalContext: rc,
          // Individual fields as fallback for backward compat
          normalizedGoal: resolvedNormalizedGoal,
          entityTerms: rc?.entityTerms || [],
          primaryEntities: rc?.primaryEntities || [],
          secondaryEntities: rc?.secondaryEntities || [],
          negativeEntities: rc?.negativeEntities || [],
          lockedPhrases: rc?.lockedPhrases || [],
          topics: rc?.topics || [],
          requestedAspects: rc?.requestedAspects || [],
        });
        if (resolverResult.ok) {
          sourceContext = resolverResult.sourceContext;
          if (serviceRetrievalMode && !sourceContext.retrieval_mode) {
            sourceContext.retrieval_mode =
              serviceRetrievalMode as import("../sources/types").SourceContext["retrieval_mode"];
          }

          // Tavily fallback: if resolver returned 0 sources for AI/Crypto topic
          if (sourceContext.source_count === 0 && sourceContext.retrieval_mode !== "db_fallback") {
            const _tavilyDebugEnabled = process.env.PAYLABS_TAVILY_DEBUG === "true";
            const _sourceCountBefore = sourceContext.source_count;
            const _retrievalModeBefore = sourceContext.retrieval_mode;
            try {
              const { detectTopics } = await import("../rsshub/topic-routes");
              const detectedTopics = detectTopics(resolvedNormalizedGoal, rc?.entityTerms || []);
              const hasAiOrCrypto = detectedTopics.some((t) => t.category === "ai" || t.category === "crypto");

              if (hasAiOrCrypto) {
                const { isTavilyEnabled, fetchTavilyLiveSources } = await import(
                  "../web-search/tavily-live-search"
                );
                const _tavilyEnabled = isTavilyEnabled();

                if (_tavilyEnabled) {
                  const primaryTopic = detectedTopics.find((t) => t.subcategory) || detectedTopics[0];
                  const tavilyResult = await fetchTavilyLiveSources({
                    userGoal: resolvedNormalizedGoal,
                    entityTerms: rc?.entityTerms || [],
                    topicCategory: primaryTopic.category,
                    topicSubcategory: primaryTopic.subcategory,
                    callerTag: "locked_orchestration",
                    routeTier: lockedTier,
                  });

                  // Always-on diagnostic for paid-path Tavily fallback
                  console.log(JSON.stringify({
                    log: "[locked_orchestration] tavily_fallback",
                    caller: "locked_orchestration",
                    source_count_before: _sourceCountBefore,
                    retrieval_mode_before: _retrievalModeBefore,
                    tavily_enabled: _tavilyEnabled,
                    topic_category: primaryTopic.category,
                    topic_subcategory: primaryTopic.subcategory || null,
                    tavily_raw_result_count: tavilyResult.result_count,
                    tavily_candidate_count: tavilyResult.candidates.length,
                    tavily_error_class: tavilyResult.error_class,
                    accepted_domains: [...new Set(tavilyResult.candidates.map((c) => c.domain).filter(Boolean))].slice(0, 10),
                  }));

                  if (tavilyResult.candidates.length > 0) {
                    // Route Tavily candidates through canonical resolveSources()
                    const tavilyRankedCandidates = tavilyResult.candidates.map((c) => ({
                      feed_item_id: c.feed_item_id,
                      rank: c.rank,
                      relevance_score: c.relevance_score,
                      // Preserve full live candidate metadata for enrichRankedCandidates
                      source_kind: "tavily_live" as const,
                      provider: "tavily" as const,
                      source_url: c.source_url || "",
                      title: c.title || "",
                      domain: c.domain || null,
                      summary: c.summary || "",
                      author: c.author || "",
                      published_at: c.published_at || null,
                      route_path: c.route_path || null,
                      reason: c.reason || "",
                    }));
                    const tavilyResolverResult = await resolveSources({
                      rankedCandidates: tavilyRankedCandidates,
                      retrievalContext: rc,
                      normalizedGoal: resolvedNormalizedGoal,
                      entityTerms: rc?.entityTerms || [],
                      primaryEntities: rc?.primaryEntities || [],
                      secondaryEntities: rc?.secondaryEntities || [],
                      negativeEntities: rc?.negativeEntities || [],
                      lockedPhrases: rc?.lockedPhrases || [],
                      topics: rc?.topics || [],
                      requestedAspects: rc?.requestedAspects || [],
                    });
                    if (tavilyResolverResult.ok && tavilyResolverResult.sourceContext.source_count > 0) {
                      sourceContext = tavilyResolverResult.sourceContext;
                      sourceContext.retrieval_mode = "rsshub_empty_tavily_live";
                      sourceContext.source_strategy = "tavily_resolved";
                    } else {
                      // Canonical resolver rejected all Tavily — return what we have
                      sourceContext = {
                        sources_used: [],
                        source_selection_summary: `RSSHub returned 0 ${primaryTopic.category} sources. Tavily found ${tavilyResult.candidates.length} candidates but none passed canonical relevance.`,
                        source_confidence: 0,
                        source_count: 0,
                        retrieval_mode: "rsshub_empty_tavily_live",
                        source_strategy: "tavily_no_pass",
                      };
                    }
                  }
                }
              }
            } catch (tavilyErr: unknown) {
              // Always-on error diagnostic for paid-path Tavily fallback
              console.warn("[locked_orchestration] Tavily fallback error", {
                caller: "locked_orchestration",
                source_count_before: _sourceCountBefore,
                retrieval_mode_before: _retrievalModeBefore,
                error: tavilyErr instanceof Error ? tavilyErr.message.slice(0, 100) : String(tavilyErr).slice(0, 100),
              });
            }
          }
        }
      } catch (e: unknown) {
        console.error("[locked_orchestration] source resolve failed", {
          error:
            e instanceof Error
              ? e.message.slice(0, 200)
              : String(e).slice(0, 200),
        });
      }
    } else if (serviceRetrievalMode) {
      // No ranked candidates — RSSHub returned 0.
      // Still try Tavily fallback for AI/Crypto topics.
      // Use canonical retrievalContext if available
      const { resolveSources: resolveSources2 } = await import("../sources/source-resolver");
      const rc2 = dData.retrievalContext as import("../sources/types").RetrievalContext | undefined;
      const normalizedGoal2 = rc2?.normalizedGoal
        || (brainData ? String(brainData.normalized_goal || "") : "");

      // Capture for evidence retrieval (used after source resolution)
      if (rc2) retrievalContextForEvidence = rc2;

      sourceContext = {
        sources_used: [],
        source_selection_summary: "No matching live RSSHub sources found.",
        source_confidence: 0,
        source_count: 0,
        retrieval_mode:
          serviceRetrievalMode as import("../sources/types").SourceContext["retrieval_mode"],
      };

      // Tavily fallback for AI/Crypto when RSSHub returned 0 candidates
      const _tavilyDebugEnabled0 = process.env.PAYLABS_TAVILY_DEBUG === "true";
      try {
        const { detectTopics } = await import("../rsshub/topic-routes");
        const detectedTopics2 = detectTopics(normalizedGoal2, rc2?.entityTerms || []);
        const hasAiOrCrypto = detectedTopics2.some((t) => t.category === "ai" || t.category === "crypto");

        if (hasAiOrCrypto) {
          const { isTavilyEnabled, fetchTavilyLiveSources } = await import(
            "../web-search/tavily-live-search"
          );
          const _tavilyEnabled0 = isTavilyEnabled();

          if (_tavilyEnabled0) {
            const primaryTopic = detectedTopics2.find((t) => t.subcategory) || detectedTopics2[0];
            const tavilyResult = await fetchTavilyLiveSources({
              userGoal: normalizedGoal2,
              entityTerms: rc2?.entityTerms || [],
              topicCategory: primaryTopic.category,
              topicSubcategory: primaryTopic.subcategory,
              callerTag: "locked_orchestration_empty",
              routeTier: lockedTier,
            });

            // Always-on diagnostic for paid-path Tavily fallback (empty path)
            console.log(JSON.stringify({
              log: "[locked_orchestration] tavily_fallback_empty",
              caller: "locked_orchestration_empty",
              source_count_before: 0,
              retrieval_mode_before: serviceRetrievalMode,
              tavily_enabled: _tavilyEnabled0,
              topic_category: primaryTopic.category,
              topic_subcategory: primaryTopic.subcategory || null,
              tavily_raw_result_count: tavilyResult.result_count,
              tavily_candidate_count: tavilyResult.candidates.length,
              tavily_error_class: tavilyResult.error_class,
              accepted_domains: [...new Set(tavilyResult.candidates.map((c) => c.domain).filter(Boolean))].slice(0, 10),
            }));

            if (tavilyResult.candidates.length > 0) {
              // Route Tavily candidates through canonical resolveSources()
              const tavilyRankedCandidates2 = tavilyResult.candidates.map((c) => ({
                feed_item_id: c.feed_item_id,
                rank: c.rank,
                relevance_score: c.relevance_score,
                // Preserve full live candidate metadata for enrichRankedCandidates
                source_kind: "tavily_live" as const,
                provider: "tavily" as const,
                source_url: c.source_url || "",
                title: c.title || "",
                domain: c.domain || null,
                summary: c.summary || "",
                author: c.author || "",
                published_at: c.published_at || null,
                route_path: c.route_path || null,
                reason: c.reason || "",
              }));
              const tavilyResolverResult2 = await resolveSources2({
                rankedCandidates: tavilyRankedCandidates2,
                retrievalContext: rc2,
                normalizedGoal: normalizedGoal2,
                entityTerms: rc2?.entityTerms || [],
                primaryEntities: rc2?.primaryEntities || [],
                secondaryEntities: rc2?.secondaryEntities || [],
                negativeEntities: rc2?.negativeEntities || [],
                lockedPhrases: rc2?.lockedPhrases || [],
                topics: rc2?.topics || [],
                requestedAspects: rc2?.requestedAspects || [],
              });
              if (tavilyResolverResult2.ok && tavilyResolverResult2.sourceContext.source_count > 0) {
                sourceContext = tavilyResolverResult2.sourceContext;
                sourceContext.retrieval_mode = "rsshub_empty_tavily_live";
                sourceContext.source_strategy = "tavily_resolved";
              } else {
                sourceContext = {
                  sources_used: [],
                  source_selection_summary: `RSSHub returned 0 ${primaryTopic.category} sources. Tavily found ${tavilyResult.candidates.length} candidates but none passed canonical relevance.`,
                  source_confidence: 0,
                  source_count: 0,
                  retrieval_mode: "rsshub_empty_tavily_live",
                  source_strategy: "tavily_no_pass",
                };
              }
            }
          }
        }
      } catch (tavilyErr: unknown) {
        // Always-on error diagnostic for paid-path Tavily fallback
        console.warn("[locked_orchestration] Tavily fallback error (empty path)", {
          caller: "locked_orchestration_empty",
          source_count_before: 0,
          retrieval_mode_before: serviceRetrievalMode,
          error: tavilyErr instanceof Error ? tavilyErr.message.slice(0, 100) : String(tavilyErr).slice(0, 100),
        });
      }
    }
  }

  // ── Evidence retrieval with coverage retry (internal RAG, gated by feature flag) ──
  let ragEvidence: import("../rag/types").EvidenceRetrievalResult | undefined;
  try {
    const { isGroundedAnswerEnabled } = await import("../feature-flags");
    if (isGroundedAnswerEnabled() && retrievalContextForEvidence && sourceContext) {
      const { runEvidenceRetrievalWithCoverage } = await import("../rag/evidence-retrieval");
      ragEvidence = await runEvidenceRetrievalWithCoverage({
        retrievalContext: retrievalContextForEvidence,
        initialSources: sourceContext.sources_used || [],
        delegatedRouteTier: lockedTier,
      });

      // Safe diagnostic — no raw chunks, no article text
      console.log(JSON.stringify({
        log: "[locked_orchestration] evidence_retrieval",
        stopped_reason: ragEvidence.stoppedReason,
        total_chunks: ragEvidence.gradedChunks.length,
        total_sources: ragEvidence.resolvedSources.length,
        retry_rounds: ragEvidence.retryRounds.length,
        coverage_entities: `${ragEvidence.coverage.coveredEntities.length}/${ragEvidence.coverage.requiredEntities.length}`,
        coverage_aspects: `${ragEvidence.coverage.coveredAspects.length}/${ragEvidence.coverage.requiredAspects.length}`,
      }));
    }
  } catch (err: unknown) {
    // Evidence retrieval failure must not fail the paid run
    console.warn("[locked_orchestration] evidence retrieval failed", {
      error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150),
    });
  }

  // ── Evidence pack (deterministic, internal RAG) ──
  let ragEvidencePack: import("../rag/types").EvidencePack | undefined;
  if (ragEvidence) {
    try {
      const { buildEvidencePack } = await import("../rag/evidence-pack");
      ragEvidencePack = buildEvidencePack({
        retrievalContext: retrievalContextForEvidence!,
        evidenceRetrieval: ragEvidence,
      });
    } catch (err: unknown) {
      console.warn("[locked_orchestration] evidence pack build failed", {
        error: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150),
      });
    }
  }

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

  return { output, _lockedPlan: lockedPlan, _ragEvidence: ragEvidence, _ragEvidencePack: ragEvidencePack };
}
