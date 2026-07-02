/**
 * PayLabs Run Orchestrator
 *
 * THE single Brain. Controls three macro-node phases via LangGraph:
 * 1. Discovery Planner
 * 2. Payment Decision Layer
 * 3. Settlement & Memory Layer
 *
 * The Brain is ALWAYS LLM-assisted (via brain-planner-graph).
 * Macro-node phases execute via their respective LangGraph graphs.
 *
 * Tier behavior:
 *   easy: Discovery Planner only
 *   normal: Discovery Planner + Payment Decision + Settlement Memory creator payout
 *   advanced: all three phases
 */

import type {
  OrchestratorInput,
  OrchestratorOutput,
  DelegatedRouteTier,
  MacroNodePhase,
  BrainPlanningOutput,
  BudgetRefundReconciliation,
} from "./types";
import type { ServiceName } from "../agent-services/types";
import {
  createOrchestratorState,
  TIER_PHASE_MAP,
  setMacroPhaseStatus,
  markOrchestratorComplete,
  addProgressSummary,
  validateAndLockExecutionPlan,
} from "./state";

// ─── Public API ──────────────────────────────────────────────

/**
 * Execute a delegated discovery run using LangGraph.
 *
 * Entry point for the delegated runtime.
 * Brain uses LangGraph brain-planner-graph (always LLM-assisted).
 * Macro-node phases use their respective LangGraph graphs.
 */
export async function executeDelegatedDiscoveryRun(
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const state = createOrchestratorState(input);
  // ── Brain Planning (LangGraph) ──
  const brainResult = await runBrainPlanning(input);

  // Store brain LLM diagnostics for safe propagation to API response
  (state as unknown as Record<string, unknown>)._brainLlmDiag = (brainResult as Record<string, unknown>).brainLlmDiag ?? null;

  // When route_tier is "auto", use Brain's recommendation
  let resolvedTier = input.routeTier;
  if (brainResult.ok && input.routeTier === ("auto" as unknown as string)) {
    const brainHint = brainResult.data.route_tier_hint;
    if (brainHint === "easy" || brainHint === "normal" || brainHint === "advanced") {
      resolvedTier = brainHint;
      addProgressSummary(state, `Brain auto-tier: "${brainHint}" (from route_tier_hint)`);
    } else {
      resolvedTier = "easy";
      addProgressSummary(state, `Brain auto-tier: fallback to "easy" (invalid hint: "${brainHint}")`);
    }
  }

  const phasesToRun = TIER_PHASE_MAP[resolvedTier] || TIER_PHASE_MAP.easy;
  state.routeTier = resolvedTier;

  addProgressSummary(
    state,
    `Orchestrator started: tier=${resolvedTier}, budget=${input.userBudgetUsdc} USDC, phases=${phasesToRun.join(",")}`
  );

  if (brainResult.ok) {
    state.brainPlanning = brainResult.data;

    const executionPlan = validateAndLockExecutionPlan(
      resolvedTier,
      brainResult.data.selected_macro_nodes,
      brainResult.data.selected_services,
      brainResult.data.max_registry_checks,
      brainResult.data.max_source_accesses,
    );
    state.executionPlan = executionPlan;

    state.brainPlanning.planned_cost_usdc = executionPlan.plannedCostUsdc;
    state.brainPlanning.planned_cost_breakdown = executionPlan.plannedCostBreakdown;
    state.brainPlanning.selected_macro_nodes = executionPlan.selectedMacroNodes;
    state.brainPlanning.selected_services = executionPlan.selectedServices;

    addProgressSummary(
      state,
      `Execution plan locked: tier=${resolvedTier}, nodes=${executionPlan.selectedMacroNodes.length}, services=${executionPlan.selectedServices.length}, plannedCost=${executionPlan.plannedCostUsdc.toFixed(6)} USDC`
    );
    addProgressSummary(
      state,
      `Brain planning: strategy="${brainResult.data.discovery_strategy.slice(0, 60)}", ${brainResult.data.service_execution_plan.length} services planned, ${brainResult.data.suggested_query_variants.length} query variants`
    );
  } else {
    const { isLlmRequired } = await import("@/lib/paylabs/ai/llm");
    if (isLlmRequired()) {
      markOrchestratorComplete(state, "failed", "Brain planning failed and PAYLABS_LLM_REQUIRED=true");
      addProgressSummary(state, "Brain planning failed — LLM required, orchestrator stopped");
      return buildOutput(state);
    }
    addProgressSummary(state, "Brain planning unavailable; continuing with tier defaults.");
  }

  try {
    const activePhases = state.executionPlan
      ? state.executionPlan.selectedMacroNodes
      : phasesToRun;
    const activeServices = state.executionPlan
      ? state.executionPlan.selectedServices
      : [];

    // ── Phase 1: Discovery Planner (LangGraph) ──
    setMacroPhaseStatus(state, "discovery_planner", "running");

    const { runDiscoveryPlannerGraph } = await import("../langgraph/macro-nodes/discovery-planner-graph");
    const discoveryResult = await runDiscoveryPlannerGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: resolvedTier,
      userBudgetUsdc: input.userBudgetUsdc,
      selectedServices: activeServices,
      brainNormalizedGoal: state.brainPlanning?.normalized_goal,
      brainDiscoveryStrategy: state.brainPlanning?.discovery_strategy,
      brainSuggestedQueryVariants: state.brainPlanning?.suggested_query_variants || [],
      brainSafeSummary: state.brainPlanning?.safe_brain_summary,
    });

    if (!discoveryResult.ok) {
      setMacroPhaseStatus(state, "discovery_planner", "failed");
      markOrchestratorComplete(state, "failed", discoveryResult.error || "Discovery planner failed");
      return buildOutput(state);
    }

    // Merge graph results into state
    for (const ev of discoveryResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of discoveryResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    // Build safe Easy→Normal handoff
    state.easyToNormalHandoff = {
      normalizedGoal: discoveryResult.normalizedGoal,
      easySummary: discoveryResult.easySummary,
      sourceCards: discoveryResult.sourceCards || [],
    };

    setMacroPhaseStatus(state, "discovery_planner", "completed");
    addProgressSummary(
      state,
      `Discovery Planner completed: ${discoveryResult.rankedCandidates.length} candidates, ${discoveryResult.sourceCards?.length || 0} source cards`
    );

    if (!activePhases.includes("payment_decision")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 2: Payment Decision (LangGraph) ──
    setMacroPhaseStatus(state, "payment_decision", "running");

    const { runPaymentDecisionGraph } = await import("../langgraph/macro-nodes/payment-decision-graph");
    const paymentResult = await runPaymentDecisionGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: state.easyToNormalHandoff.normalizedGoal,
      routeTier: resolvedTier,
      userBudgetUsdc: input.userBudgetUsdc,
      sourceCards: state.easyToNormalHandoff.sourceCards,
      discoverySummary: state.easyToNormalHandoff.easySummary,
      selectedServices: activeServices,
    });

    if (!paymentResult.ok) {
      setMacroPhaseStatus(state, "payment_decision", "failed");
      markOrchestratorComplete(state, "failed", paymentResult.error || "Payment decision failed");
      return buildOutput(state);
    }

    for (const ev of paymentResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of paymentResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    setMacroPhaseStatus(state, "payment_decision", "completed");
    addProgressSummary(
      state,
      `Payment Decision completed: ${paymentResult.approvedItems.length} approved, ${paymentResult.skippedItems.length} skipped`
    );

    state.paymentPlan = paymentResult.approvedItems.map((item) => ({
      itemId: item.feed_item_id,
      sourceUrl: item.source_url,
      sourceTitle: item.source_title,
      priceUsdc: item.approved_price_usdc,
      approved: true,
      skipReason: null,
      finalScore: item.final_score,
      riskScore: item.risk_score,
    }));

    if (!activePhases.includes("settlement_memory")) {
      markOrchestratorComplete(state, "completed");
      return buildOutput(state);
    }

    // ── Phase 3: Settlement Memory (LangGraph) ──
    setMacroPhaseStatus(state, "settlement_memory", "running");

    const { runSettlementMemoryGraph } = await import("../langgraph/macro-nodes/settlement-memory-graph");
    const settlementResult = await runSettlementMemoryGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: resolvedTier,
      userBudgetUsdc: input.userBudgetUsdc,
      approvedItems: paymentResult.approvedItems,
      selectedServices: activeServices,
    });

    if (!settlementResult.ok) {
      setMacroPhaseStatus(state, "settlement_memory", "failed");
      markOrchestratorComplete(state, "failed", settlementResult.error || "Settlement failed");
      return buildOutput(state);
    }

    for (const ev of settlementResult.serviceEvaluations) {
      state.serviceEvaluations.push(ev);
    }
    for (const pe of settlementResult.paymentEdges) {
      state.paymentEdges.push(pe);
    }

    // Store creator distribution data for output — use split plan fields from settlement graph
    ((state as unknown) as Record<string, unknown>)._creatorDistribution = {
      payoutSummary: settlementResult.creatorPayoutSummary || null,
      payoutResults: settlementResult.creatorPayoutResults || [],
      evaluatorOutput: settlementResult.advancedEvaluatorOutput || null,
      pendingReserveAtomic: settlementResult.pendingCreatorReserveAtomic ?? null,
      actualCreatorPaidAtomic: settlementResult.actualCreatorPaidAtomic ?? null,
      actualCreatorPaidUsdc: settlementResult.actualCreatorPaidUsdc ?? null,
      creatorSplitPlan: settlementResult.creatorSplitPlan ?? null,
      plannedCreatorPoolAtomic: settlementResult.plannedCreatorPoolAtomic ?? null,
      plannedCreatorPayoutCount: settlementResult.plannedCreatorPayoutCount ?? null,
      advancedEvaluatorStatus: settlementResult.advancedEvaluatorStatus ?? null,
    };

    setMacroPhaseStatus(state, "settlement_memory", "completed");
    addProgressSummary(
      state,
      `Settlement completed: ${settlementResult.routedItems.length} routed, ${settlementResult.failedItems.length} failed. Mode: creator-distribution.`
    );

    markOrchestratorComplete(state, "completed");
    return await buildOutputWithRefund(state, input);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    markOrchestratorComplete(state, "failed", `Orchestrator error: ${msg}`);
    return buildOutput(state);
  }
}

// ─── Brain Planning (LangGraph) ──────────────────────────────

async function runBrainPlanning(
  input: OrchestratorInput
): Promise<{ ok: true; data: BrainPlanningOutput; brainLlmDiag?: Record<string, unknown> } | { ok: false; error: string; brainLlmDiag?: Record<string, unknown> }> {
  try {
    const { runBrainPlannerGraph } = await import("../langgraph/brain/brain-planner-graph");
    const result = await runBrainPlannerGraph({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      userWallet: input.userWallet,
    });

    if (result.ok && result.brainPlanning) {
      return { ok: true, data: result.brainPlanning, brainLlmDiag: result.brainLlmDiag };
    }
    return { ok: false, error: result.error || "Brain planning failed", brainLlmDiag: result.brainLlmDiag };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Brain graph error: ${msg}` };
  }
}

// ─── Output Builders ─────────────────────────────────────────

function buildOutput(state: ReturnType<typeof createOrchestratorState>): OrchestratorOutput {
  const phasesCompleted = (Object.entries(state.macroNodeProgress) as Array<[string, string]>)
    .filter(([, status]) => status === "completed")
    .map(([phase]) => phase as OrchestratorOutput["phasesCompleted"][number]);

  return {
    discoveryRunId: state.discoveryRunId,
    status: state.orchestratorStatus,
    routeTier: state.routeTier,
    phasesCompleted,
    safeProgressSummaries: state.safeProgressSummaries,
    budgetSnapshot: state.budgetSnapshot,
    consensusDecisions: state.consensusDecisions,
    paymentPlan: state.paymentPlan,
    paymentEdges: state.paymentEdges,
    serviceEvaluations: state.serviceEvaluations,
    brainPlanning: state.brainPlanning,
    paymentGraph: state.paymentGraph,
    tieredSummaries: buildTieredSummaries(state),
    easyToNormalHandoff: state.easyToNormalHandoff,
    creatorDistribution: ((state as unknown) as Record<string, unknown>)._creatorDistribution as OrchestratorOutput["creatorDistribution"],
    _brainLlmDiag: ((state as unknown) as Record<string, unknown>)._brainLlmDiag as Record<string, unknown> | undefined,
    error: state.error,
  };
}

// ─── Refund Reconciliation (async, fail-soft) ───────────────

/**
 * Build output with budget refund reconciliation.
 * Fail-soft: if reconciliation fails, output still returns with error status.
 */
async function buildOutputWithRefund(
  state: ReturnType<typeof createOrchestratorState>,
  input: OrchestratorInput
): Promise<OrchestratorOutput> {
  const output = buildOutput(state);

  try {
    const {
      buildSafeBudgetRefundContext,
      toBrainSafeRefundContext,
      reconcileAndMaybeRefund,
    } = await import("../budget/refund-reconciliation");
    const { getBrainRefundRecommendation } = await import("../budget/refund-brain-policy");

    // Derive paidUpfrontUsdc from real entry payment receipt state only.
    // Currently no real entry payment capture exists — default to 0.
    const paidUpfrontUsdc = 0;

    const safeRefundContext = buildSafeBudgetRefundContext({
      input,
      state,
      executionPlan: state.executionPlan,
      budgetSnapshot: state.budgetSnapshot,
      serviceEvaluations: state.serviceEvaluations,
      paymentEdges: state.paymentEdges,
      paidUpfrontUsdc,
    });

    // Ask Brain for recommendation (advisory only, fail-soft)
    const brainSafeContext = toBrainSafeRefundContext(safeRefundContext, state.routeTier);
    const brainRecommendation = await getBrainRefundRecommendation(brainSafeContext);

    // Backend deterministic reconciliation
    const budgetRefundReconciliation = await reconcileAndMaybeRefund({
      context: safeRefundContext,
      brainRecommendation,
    });

    const output2 = { ...output, budgetRefundReconciliation };

    // Append refund-aware wording to tier summaries (no overclaiming)
    if (output2.tieredSummaries) {
      const refundNote = "Budget/refund status is reported separately.";
      if (output2.tieredSummaries.easy_summary && !output2.tieredSummaries.easy_summary.includes(refundNote)) {
        output2.tieredSummaries.easy_summary += ` ${refundNote}`;
      }
      if (output2.tieredSummaries.normal_summary && !output2.tieredSummaries.normal_summary.includes(refundNote)) {
        output2.tieredSummaries.normal_summary += ` ${refundNote}`;
      }
      if (output2.tieredSummaries.advanced_summary) {
        output2.tieredSummaries.advanced_summary += " Real settlement/refund status is shown only when safe payment evidence exists.";
      }
    }

    return output2;
  } catch (e: unknown) {
    // Fail-soft: refund failure must not erase main run result
    const refundErr = e instanceof Error ? e.message : String(e);
    const failedReconciliation: BudgetRefundReconciliation = {
      userBudgetUsdc: input.userBudgetUsdc,
      plannedCostUsdc: state.executionPlan?.plannedCostUsdc ?? 0,
      paidUpfrontUsdc: 0,
      actualSettledUsdc: 0,
      estimatedUnsettledUsdc: 0,
      pendingSettlementUsdc: 0,
      refundableUsdc: 0,
      refundRequired: false,
      refundStatus: "failed",
      summary: `Refund reconciliation error: ${refundErr}`,
    };
    return { ...output, budgetRefundReconciliation: failedReconciliation };
  }
}

// ─── Safe Candidate Extraction ─────────────────────────────

/** Safe candidate object — only user-facing fields, no raw payloads/wallets/sigs. */
interface SafeCandidate {
  title: string;
  publisher: string;
  rank: number;
  relevance_score: number;
  reason?: string;
  feed_item_id: string;
}

/**
 * Extract safe candidate objects from Signal Scout service evaluations.
 * Only includes title, publisher, rank, relevance_score, reason, feed_item_id.
 * Never exposes raw RSS payload, wallet data, x402 metadata, signatures, or tx hashes.
 */
function extractDiscoveryCandidates(
  state: ReturnType<typeof createOrchestratorState>
): SafeCandidate[] {
  const candidates: SafeCandidate[] = [];
  const scoutEvals = state.serviceEvaluations.filter(
    (e) => e.macroNode === "discovery_planner" && (e.serviceName === "signal_scout" || e.serviceName === "signal_scout_basics") && e.output
  );
  for (const eval_ of scoutEvals) {
    const rc = (eval_.output as Record<string, unknown>)?.ranked_candidates;
    if (!Array.isArray(rc)) continue;
    for (const item of rc) {
      const c = item as Record<string, unknown>;
      candidates.push({
        title: String(c.title || ""),
        publisher: String(c.publisher || ""),
        rank: Number(c.rank) || 0,
        relevance_score: Number(c.relevance_score) || 0,
        reason: c.reason ? String(c.reason) : undefined,
        feed_item_id: String(c.feed_item_id || ""),
      });
    }
  }
  // Sort by rank ascending (rank 1 = best)
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates;
}

/**
 * Build a deterministic user-facing easy summary from Brain planning + Signal Scout candidates.
 * No LLM. No payment internals. No settlement/wallet/x402 data.
 */
function buildEasyUserFacingSummary(
  state: ReturnType<typeof createOrchestratorState>
): { easy_summary: string; final_summary: string } {
  const candidates = extractDiscoveryCandidates(state);
  const goal = state.brainPlanning?.normalized_goal || state.userGoal;
  const routeTier = state.routeTier;

  if (candidates.length === 0) {
    const easy = `No useful source candidates were found for: "${goal.slice(0, 80)}". The discovery planner ran but found no matching feed items.`;
    return { easy_summary: easy, final_summary: easy };
  }

  // Top 3 for user-facing summary
  const top3 = candidates.slice(0, 3);
  const topNames = top3
    .map((c) => {
      const parts: string[] = [];
      if (c.title) parts.push(c.title);
      if (c.publisher && c.publisher !== c.title) parts.push(`(${c.publisher})`);
      return parts.join(" ") || c.feed_item_id;
    })
    .join(", ");

  const easyLines = [
    `Found ${candidates.length} relevant source candidates for: "${goal.slice(0, 80)}".`,
    `Top candidates: ${topNames}.`,
    `Easy route only performed discovery/ranking; it did not run source verification or trust checks.`,
  ];
  const easy_summary = easyLines.join(" ");

  // final_summary for easy route — mirrors easy, no overclaiming
  if (routeTier === "easy") {
    const finalLines = [
      `Found ${candidates.length} source candidates matching the discovery goal.`,
      `Strongest candidates are ranked by entity/query relevance.`,
      `This is an easy-route discovery result — no source verification or trust checks were performed.`,
    ];
    return { easy_summary, final_summary: finalLines.join(" ") };
  }

  // For normal/advanced, final_summary will be built by buildTieredSummaries
  return { easy_summary, final_summary: easy_summary };
}

function buildTieredSummaries(state: ReturnType<typeof createOrchestratorState>): OrchestratorOutput["tieredSummaries"] {
  const summaries: Record<string, string | undefined> = {};

  // ── Easy summary: use easyToNormalHandoff if available, else build from evals ──
  if (state.easyToNormalHandoff) {
    summaries.easy_summary = state.easyToNormalHandoff.easySummary;
  } else {
    const discoveryEvals = state.serviceEvaluations.filter((e) => e.macroNode === "discovery_planner");
    if (discoveryEvals.length > 0) {
      const { easy_summary } = buildEasyUserFacingSummary(state);
      summaries.easy_summary = easy_summary;
    }
  }

  // ── Normal summary: payment decision ──
  const paymentEvals = state.serviceEvaluations.filter((e) => e.macroNode === "payment_decision");
  if (paymentEvals.length > 0) {
    const deciderEval = paymentEvals.find((e) => e.serviceName === "payment_decider");
    if (deciderEval?.output) {
      const d = deciderEval.output as Record<string, unknown>;
      const approved = (d.approved_items as unknown[])?.length || 0;
      const skipped = (d.skipped_items as unknown[])?.length || 0;
      const candidateCount = state.easyToNormalHandoff?.sourceCards?.length || 0;
      const totalSpend = Number(d.total_estimated_spend) || 0;
      if (candidateCount === 0) {
        summaries.normal_summary = "Normal route had no discovery source cards to evaluate.";
      } else if (approved === 0) {
        summaries.normal_summary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. None passed the decision gate.`;
      } else {
        summaries.normal_summary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. ${approved} passed the decision gate and ${skipped} were skipped. Estimated approved spend: ${totalSpend.toFixed(6)} USDC.`;
      }
    }
  }

  // ── Advanced summary: settlement ──
  const settlementEvals = state.serviceEvaluations.filter((e) => e.macroNode === "settlement_memory");
  if (settlementEvals.length > 0) {
    const routerEval = settlementEvals.find((e) => e.serviceName === "creator_payout_router");
    if (routerEval?.output) {
      const r = routerEval.output as Record<string, unknown>;
      const payoutResults = (r.creator_payout_results as unknown[])?.length || 0;
      summaries.advanced_summary = `Settlement: ${payoutResults} creator payouts processed.`;
    }
  }

  // ── Final summary: combine tier summaries (no raw progress list) ──
  const parts: string[] = [];
  if (summaries.easy_summary) parts.push(summaries.easy_summary);
  if (summaries.normal_summary) parts.push(summaries.normal_summary);
  if (summaries.advanced_summary) parts.push(summaries.advanced_summary);
  if (parts.length > 0) {
    summaries.final_summary = parts.join("\n\n");
  } else {
    summaries.final_summary = state.safeProgressSummaries.join(" | ") || "Run completed.";
  }

  return summaries as unknown as OrchestratorOutput["tieredSummaries"];
}
