/**
 * PayLabs Tutor LangGraph Workflow — 15-Agent Production Core
 *
 * Two separate graphs:
 * 1. Proposal: START → tutor_intake → intent_classifier → query_expander →
 *    feed_discovery → source_ranker → evidence_allocator → stop_limit_controller →
 *    budget_optimizer → source_quality → provenance → creator_ownership →
 *    persist_source_path → END
 *
 * 2. Payment: START → policy_guard → payment_quote → payment_executor →
 *    receipt_auditor → END
 *
 * Proposal and payment are separate invocations.
 * Payment is impossible until the user approves the source path.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 *
 * All 15 agents are LLM-backed. Payment-critical decisions still have
 * deterministic backend checks. No hardcoded Runner — uses Payment Adapter.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { PayLabsTutorState } from "./state";
import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getRouteConfig, getRouteLimits, computeEffectiveSpendCap } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { supabaseAdmin } from "@/lib/supabase/server";

// ─── Agent imports (new 15-agent architecture) ─────────────────
import { tutorIntakeAgent } from "./agents/tutor-intake-agent";
import { intentClassifierAgent } from "./agents/intent-classifier-agent";
import { queryExpanderAgent } from "./agents/query-expander-agent";
import { feedDiscoveryAgent } from "./agents/feed-discovery-agent";
import { sourceRankerAgent } from "./agents/source-ranker-agent";
import { evidenceAllocatorAgent } from "./agents/evidence-allocator-agent";
import { stopLimitControllerAgent } from "./agents/stop-limit-controller-agent";
import { budgetOptimizerAgent } from "./agents/budget-optimizer-agent";
import { sourceQualityVerifierAgent } from "./agents/source-quality-verifier-agent";
import { provenanceVerifierAgent } from "./agents/provenance-verifier-agent";
import { creatorOwnershipVerifierAgent } from "./agents/creator-ownership-verifier-agent";
import { policyGuardAgent } from "./agents/policy-guard-agent";
import { paymentQuoteAgent } from "./agents/payment-quote-agent";
import { paymentExecutorAgent } from "./agents/payment-executor-agent";
import { receiptAuditorAgent } from "./agents/receipt-auditor-agent";

// ─── Persist Proposed Source Path Node ───────────────────────────

async function persistProposedSourcePathNode(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const {
    userWallet, goal, budgetUsdc, verifiedSources, allVerified,
    routeTier, routeConfig, routeLimits, effectiveSpendCapUsdc,
    agentTrace, llmOutputs, llmErrors, agentServiceCalls,
    selectedSources, estimatedTotalUsdc, estimatedCreatorPayoutUsdc,
    estimatedAgentFeeUsdc, estimatedTreasuryFeeUsdc,
    stopReason, stopLimitHit,
  } = state;
  const tier: RouteTier = routeTier || "normal";
  const config = routeConfig || getRouteConfig(tier);
  const limits = routeLimits || getRouteLimits(tier);

  if (!allVerified || !verifiedSources || verifiedSources.length === 0) {
    return {
      error: "Cannot persist: no verified sources",
      sourcePathStatus: "none",
    };
  }

  try {
    // Build full agent trace
    const fullAgentTrace = {
      ...(agentTrace || {}),
      ...(llmOutputs && Object.keys(llmOutputs).length > 0 ? { llm_outputs: llmOutputs } : {}),
      ...(llmErrors && Object.keys(llmErrors).length > 0 ? { llm_errors: llmErrors } : {}),
      ...(agentServiceCalls && agentServiceCalls.length > 0 ? { agent_service_calls: agentServiceCalls } : {}),
    };

    // Insert source path
    const { data: pathRow, error: pathErr } = await supabaseAdmin()
      .from("paylabs_source_paths")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        goal: goal || "",
        budget_usdc: budgetUsdc || 0,
        effective_spend_cap_usdc: effectiveSpendCapUsdc || 0,
        estimated_total_usdc: estimatedTotalUsdc || 0,
        estimated_creator_payout_usdc: estimatedCreatorPayoutUsdc || 0,
        estimated_agent_fee_usdc: estimatedAgentFeeUsdc || 0,
        estimated_treasury_fee_usdc: estimatedTreasuryFeeUsdc || 0,
        route_tier: tier,
        route_config: config,
        route_limits: limits,
        stop_reason: stopReason || null,
        stop_limit_hit: stopLimitHit || false,
        status: "proposed",
        created_by_agent_id: "paylabs-langgraph-v2",
        agent_trace: fullAgentTrace,
      })
      .select("id, status")
      .single();

    if (pathErr || !pathRow) {
      return {
        error: `Failed to create source path: ${pathErr?.message}`,
        sourcePathStatus: "none",
      };
    }

    // Build lookup from selectedSources
    const selectedMap = new Map<string, Record<string, unknown>>();
    for (const s of (selectedSources as Record<string, unknown>[] || [])) {
      selectedMap.set(s.feed_item_id as string, s);
    }

    // Load feed items from DB for real price/wallet/URL fields
    const { listFeedItems } = await import("./tools");
    const allFeedItems = await listFeedItems() as Record<string, unknown>[];
    const feedItemMap = new Map<string, Record<string, unknown>>();
    for (const fi of allFeedItems) {
      feedItemMap.set(fi.id as string, fi);
    }

    let computedTotal = 0;
    const pathItems: Record<string, unknown>[] = [];
    const verifiedList = verifiedSources as Record<string, unknown>[];

    for (let i = 0; i < verifiedList.length; i++) {
      const v = verifiedList[i];
      const feedItemId = v.feed_item_id as string;
      const feedItem = feedItemMap.get(feedItemId);
      const selected = selectedMap.get(feedItemId);
      const citationPrice = Number((feedItem?.price_per_citation_usdc as number) || 0);
      const unlockPrice = Number((feedItem?.price_per_unlock_usdc as number) || 0);
      computedTotal += citationPrice;

      pathItems.push({
        source_path_id: pathRow.id,
        feed_item_id: feedItemId,
        order_index: i,
        reason: (selected?.reason as string) || (v.verification_reason as string) || "",
        expected_value: (selected?.expected_value as string) || "Verified RSSHub source",
        source_url: String(feedItem?.canonical_url || ""),
        source_title: String(feedItem?.title || ""),
        publisher: String(feedItem?.publisher || ""),
        author_name: String(feedItem?.author_name || ""),
        normalized_sha256: String(feedItem?.normalized_sha256 || ""),
        content_sha256: String(feedItem?.content_sha256 || ""),
        source_hash: String(feedItem?.content_sha256 || ""),
        creator_wallet: String(feedItem?.creator_wallet || "").toLowerCase(),
        is_monetized: feedItem?.is_monetized === true,
        citation_price_usdc: citationPrice,
        unlock_price_usdc: unlockPrice,
        evidence_score: selected?.evidence_score || null,
        marginal_value_score: selected?.marginal_value_score || null,
        status: "proposed",
      });
    }

    // Update estimated total
    await supabaseAdmin()
      .from("paylabs_source_paths")
      .update({
        estimated_total_usdc: computedTotal,
        agent_reasoning_summary: `LangGraph 15-agent verified ${verifiedList.length} sources for goal: ${(goal || "").slice(0, 100)}. Total: ${computedTotal} USDC`,
      })
      .eq("id", pathRow.id);

    const { error: itemsErr } = await supabaseAdmin()
      .from("paylabs_source_path_items")
      .insert(pathItems);

    if (itemsErr) {
      await supabaseAdmin()
        .from("paylabs_source_paths")
        .delete()
        .eq("id", pathRow.id);
      return {
        error: `Failed to create source path items: ${itemsErr.message}`,
        sourcePathStatus: "none",
      };
    }

    return {
      sourcePathId: pathRow.id,
      sourcePathStatus: "proposed",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Persist failed: ${msg}`, sourcePathStatus: "none" };
  }
}

// ─── Proposal Graph (12 nodes) ──────────────────────────────────

const proposalGraph = new StateGraph(PayLabsTutorState)
  .addNode("tutor_intake", tutorIntakeAgent)
  .addNode("intent_classifier", intentClassifierAgent)
  .addNode("query_expander", queryExpanderAgent)
  .addNode("feed_discovery", feedDiscoveryAgent)
  .addNode("source_ranker", sourceRankerAgent)
  .addNode("evidence_allocator", evidenceAllocatorAgent)
  .addNode("stop_limit_controller", stopLimitControllerAgent)
  .addNode("budget_optimizer", budgetOptimizerAgent)
  .addNode("source_quality_verifier", sourceQualityVerifierAgent)
  .addNode("provenance_verifier", provenanceVerifierAgent)
  .addNode("creator_ownership_verifier", creatorOwnershipVerifierAgent)
  .addNode("persist_source_path", persistProposedSourcePathNode)
  .addEdge(START, "tutor_intake")
  .addEdge("tutor_intake", "intent_classifier")
  .addEdge("intent_classifier", "query_expander")
  .addEdge("query_expander", "feed_discovery")
  .addEdge("feed_discovery", "source_ranker")
  .addEdge("source_ranker", "evidence_allocator")
  .addEdge("evidence_allocator", "stop_limit_controller")
  .addEdge("stop_limit_controller", "budget_optimizer")
  .addEdge("budget_optimizer", "source_quality_verifier")
  .addEdge("source_quality_verifier", "provenance_verifier")
  .addEdge("provenance_verifier", "creator_ownership_verifier")
  .addEdge("creator_ownership_verifier", "persist_source_path")
  .addEdge("persist_source_path", END)
  .compile();

// ─── Payment Graph (4 nodes) ────────────────────────────────────

const sourcePaymentGraph = new StateGraph(PayLabsTutorState)
  .addNode("policy_guard", policyGuardAgent)
  .addNode("payment_quote", paymentQuoteAgent)
  .addNode("payment_executor", paymentExecutorAgent)
  .addNode("receipt_auditor", receiptAuditorAgent)
  .addEdge(START, "policy_guard")
  .addEdge("policy_guard", "payment_quote")
  .addEdge("payment_quote", "payment_executor")
  .addEdge("payment_executor", "receipt_auditor")
  .addEdge("receipt_auditor", END)
  .compile();

// ─── Public API ──────────────────────────────────────────────────

export async function proposeSourcePath(input: {
  userWallet: string;
  goal: string;
  budgetUsdc: number;
  routeTier?: RouteTier;
}) {
  const tier: RouteTier = input.routeTier || "normal";
  const config = getRouteConfig(tier);
  const limits = getRouteLimits(tier);
  const effectiveCap = computeEffectiveSpendCap(input.budgetUsdc, tier);

  // ── Deterministic pre-check: skip 15-agent pipeline if no eligible sources ──
  const { listMonetizedFeedItems } = await import("./tools");
  const eligibleSources = await listMonetizedFeedItems();
  if (eligibleSources.length === 0) {
    return {
      sourcePathId: undefined,
      sourcePathStatus: "none" as const,
      goal: input.goal,
      budgetUsdc: input.budgetUsdc,
      effectiveSpendCapUsdc: effectiveCap,
      routeTier: tier,
      routeConfig: config,
      routeLimits: limits,
      selectedSources: [],
      excludedSources: [],
      verifiedSources: [],
      rejectedSources: [],
      stopReason: "no_eligible_sources",
      stopLimitHit: false,
      estimatedTotalUsdc: 0,
      estimatedCreatorPayoutUsdc: 0,
      estimatedAgentFeeUsdc: 0,
      estimatedTreasuryFeeUsdc: 0,
      remainingUsdc: 0,
      agentServiceCalls: [],
      agentTrace: { pre_check: "no_verified_monetized_sources" },
      error: "No verified monetized sources available",
      eligibleSourceCount: 0,
    };
  }

  const result = await proposalGraph.invoke({
    userWallet: input.userWallet,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    routeTier: tier,
    routeConfig: config as unknown as Record<string, unknown>,
    routeLimits: limits,
    effectiveSpendCapUsdc: effectiveCap,
    agentTrace: {},
    topics: [],
    riskNotes: [],
    sourcePathStatus: "none" as const,
    selectedSources: [],
    candidateSources: [],
    eligibleSources: [],
    rankedSources: [],
    excludedSources: [],
    verifiedSources: [],
    rejectedSources: [],
  } as unknown as PayLabsTutorStateType);

  return {
    sourcePathId: result.sourcePathId,
    sourcePathStatus: result.sourcePathStatus,
    goal: input.goal,
    budgetUsdc: input.budgetUsdc,
    effectiveSpendCapUsdc: result.effectiveSpendCapUsdc || effectiveCap,
    routeTier: tier,
    routeConfig: config,
    routeLimits: limits,
    selectedSources: result.selectedSources,
    excludedSources: result.excludedSources,
    verifiedSources: result.verifiedSources,
    rejectedSources: result.rejectedSources,
    stopReason: result.stopReason,
    stopLimitHit: result.stopLimitHit,
    estimatedTotalUsdc: result.estimatedTotalUsdc,
    estimatedCreatorPayoutUsdc: result.estimatedCreatorPayoutUsdc,
    estimatedAgentFeeUsdc: result.estimatedAgentFeeUsdc,
    estimatedTreasuryFeeUsdc: result.estimatedTreasuryFeeUsdc,
    remainingUsdc: result.remainingUsdc,
    agentServiceCalls: result.agentServiceCalls || [],
    agentTrace: result.agentTrace,
    error: result.error,
    eligibleSourceCount: eligibleSources.length,
  };
}

export async function executeSourcePayment(input: {
  userWallet: string;
  sourcePathId: string;
  sourcePathItemId: string;
}) {
  const { data: pathRow } = await supabaseAdmin()
    .from("paylabs_source_paths")
    .select("route_tier, route_config, agent_trace")
    .eq("id", input.sourcePathId)
    .single();

  const tier: RouteTier = (pathRow?.route_tier as RouteTier) || "normal";
  const config = pathRow?.route_config || getRouteConfig(tier);

  // Payment graph — same safety for all routes
  const result = await sourcePaymentGraph.invoke({
    userWallet: input.userWallet,
    sourcePathId: input.sourcePathId,
    sourcePathItemId: input.sourcePathItemId,
    routeTier: tier,
    routeConfig: config as Record<string, unknown>,
    topics: [],
    riskNotes: [],
    sourcePathStatus: "none" as const,
    selectedSources: [],
    verifiedSources: [],
    rejectedSources: [],
  } as unknown as PayLabsTutorStateType);

  return {
    allowed: result.policyDecision?.allowed,
    sourcePaymentId: result.sourcePaymentId,
    receiptId: result.receiptId,
    paymentAdapterResult: result.paymentAdapterResult,
    receiptAudit: result.receiptAudit,
    error: result.error,
    policyDecision: result.policyDecision,
  };
}
