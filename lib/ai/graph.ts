/**
 * PayLabs Tutor LangGraph Workflow
 *
 * 15 LLM-backed agents + 1 DB persistence node = 16 total nodes.
 * Proposal graph: 11 LLM agents + 1 DB node (12 nodes).
 * Payment graph: 4 LLM/deterministic payment agents (4 nodes).
 *
 * 7 of the 15 LLM agents are x402-paid audited nodes (withPaidNode wrapper).
 * 8 of the 15 LLM agents are free/internal with deterministic backend guardrails.
 * persist_source_path is a DB persistence node, not an LLM agent.
 * Payment execution and final payment proof are deterministic, not LLM-controlled.
 *
 * Proposal graph (12 nodes):
 *   tutor_intake → intent_classifier → query_expander → feed_discovery →
 *   source_ranker → evidence_allocator → stop_limit_controller →
 *   budget_optimizer → source_quality_verifier → provenance_verifier →
 *   creator_ownership_verifier → persist_source_path → END
 *
 * Payment graph (4 nodes):
 *   policy_guard → payment_quote → payment_executor → receipt_auditor → END
 *
 * x402-paid LLM agents (7):
 *   tutor_intake, intent_classifier, query_expander,
 *   source_ranker (paid identity: discovery_ranker),
 *   source_quality_verifier, provenance_verifier,
 *   creator_ownership_verifier (paid identity: attribution_auditor)
 *
 * Free/internal LLM agents (8):
 *   feed_discovery, evidence_allocator, stop_limit_controller,
 *   budget_optimizer, policy_guard, payment_quote,
 *   payment_executor, receipt_auditor
 *
 * DB persistence node (1): persist_source_path
 *
 * Proposal and payment are separate invocations.
 * Payment is impossible until the user approves the source path.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
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

// ─── Paid node wrapper (x402 nanopayment tracking) ───────────
import { withPaidNode } from "@/lib/paylabs/paid-agent-node";

// ─── Discovery-only imports ────────────────────────────────────
import { z } from "zod";
import { generateStructuredJson } from "./llm-structured";

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
      const isUnclaimed = (v.claim_status as string) === "unclaimed" || (v.is_creator_payout_eligible === false);
      // Unclaimed sources: creator payout = 0, fee goes to treasury
      const citationPrice = isUnclaimed ? 0 : Number((feedItem?.price_per_citation_usdc as number) || 0);
      const unlockPrice = isUnclaimed ? 0 : Number((feedItem?.price_per_unlock_usdc as number) || 0);
      computedTotal += citationPrice;

      pathItems.push({
        source_path_id: pathRow.id,
        feed_item_id: feedItemId,
        order_index: i,
        reason: (selected?.reason as string) || (v.verification_reason as string) || "",
        expected_value: isUnclaimed ? "Unclaimed source — treasury agent fee only" : ((selected?.expected_value as string) || "Verified RSSHub source"),
        source_url: String(feedItem?.canonical_url || ""),
        source_title: String(feedItem?.title || ""),
        publisher: String(feedItem?.publisher || ""),
        author_name: String(feedItem?.author_name || ""),
        normalized_sha256: String(feedItem?.normalized_sha256 || ""),
        content_sha256: String(feedItem?.content_sha256 || ""),
        source_hash: String(feedItem?.content_sha256 || ""),
        creator_wallet: isUnclaimed ? null : (feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : null),
        is_monetized: isUnclaimed ? false : (feedItem?.is_monetized === true),
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
// 7 x402-paid agents use withPaidNode() wrapper.
// 4 free/internal agents + 1 DB node run without wrapper.

const proposalGraph = new StateGraph(PayLabsTutorState)
  // x402-paid: interprets user goal / initial intent
  .addNode("tutor_intake", withPaidNode("tutor_intake", tutorIntakeAgent))
  // x402-paid: classifies workflow and NL constraints
  .addNode("intent_classifier", withPaidNode("intent_classifier", intentClassifierAgent))
  // x402-paid: expands goal into query/source-discovery intent
  .addNode("query_expander", withPaidNode("query_expander", queryExpanderAgent))
  // free: hybrid DB filter + LLM review (deterministic candidate set)
  .addNode("feed_discovery", feedDiscoveryAgent)
  // x402-paid: source relevance ranking (paid identity: discovery_ranker)
  .addNode("source_ranker", withPaidNode("discovery_ranker", sourceRankerAgent))
  // free: evidence path planning (internal reasoning, not paid capability)
  .addNode("evidence_allocator", evidenceAllocatorAgent)
  // free: deterministic budget/source caps (LLM for explanation only)
  .addNode("stop_limit_controller", stopLimitControllerAgent)
  // free: deterministic math/split/cap (LLM for explanation only)
  .addNode("budget_optimizer", budgetOptimizerAgent)
  // x402-paid: paid source-quality assessment
  .addNode("source_quality_verifier", withPaidNode("source_quality_verifier", sourceQualityVerifierAgent))
  // x402-paid: paid provenance/audit reasoning from DB metadata
  .addNode("provenance_verifier", withPaidNode("provenance_verifier", provenanceVerifierAgent))
  // x402-paid: hybrid DB truth + LLM summary (paid identity: attribution_auditor)
  .addNode("creator_ownership_verifier", withPaidNode("attribution_auditor", creatorOwnershipVerifierAgent))
  // DB persistence node (not an LLM agent)
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

// ─── Discovery-Only Flow ─────────────────────────────────────────
//
// When no monetized sources exist, run a lightweight discovery + ranking
// on ALL active feed items. Persists to paylabs_discovery_runs/items.
// No payment, no creator wallet exposed for unmonetized sources.

const DiscoveryRankSchema = z.object({
  ranked_sources: z.array(z.object({
    feed_item_id: z.string(),
    rank: z.number(),
    relevance_score: z.number(),
    reason: z.string(),
  })),
});

const DISCOVERY_RANK_PROMPT = `You are PayLabs Discovery Agent. Rank the provided feed items by relevance to the user's goal. These are unclaimed/unmonetized sources — no payment will be made. Select the most useful items for the user's research need. Return structured JSON only.`;

export async function discoverOnly(input: {
  userWallet: string;
  goal: string;
  routeTier: RouteTier;
}) {
  const { listActiveFeedItems } = await import("./tools");
  const allActive = await listActiveFeedItems() as Record<string, unknown>[];

  if (allActive.length === 0) {
    return {
      status: "failed" as const,
      discoveryRunId: undefined,
      candidateCount: 0,
      eligibleSourceCount: 0,
      unclaimedSourceCount: 0,
      unclaimedSources: [],
      error: "No active feed items found",
    };
  }

  // Determine claim status for each item
  const classifyItem = (item: Record<string, unknown>): {
    claim_status: string;
    is_monetized: boolean;
  } => {
    const route = Array.isArray(item.rsshub_route)
      ? (item.rsshub_route as Record<string, unknown>[])[0]
      : item.rsshub_route as Record<string, unknown> | undefined;

    const routeVerified = route?.verification_status === "verified";
    const itemMonetized = item.is_monetized === true && !!item.creator_wallet;

    if (routeVerified && itemMonetized) {
      return { claim_status: "verified", is_monetized: true };
    }
    if (route?.verification_status === "pending_claim") {
      return { claim_status: "pending_claim", is_monetized: false };
    }
    return { claim_status: "unclaimed", is_monetized: false };
  };

  // Safe metadata for LLM — no wallet, no price
  const feedMeta = allActive.map((item) => ({
    id: item.id,
    title: item.title,
    summary: (item.summary as string || "").slice(0, 200),
    publisher: item.publisher,
    author_name: item.author_name,
    published_at: item.published_at,
  }));

  // LLM ranking — single call, lightweight
  const rankResult = await generateStructuredJson<z.infer<typeof DiscoveryRankSchema>>({
    agentName: "discovery_ranker",
    routeTier: input.routeTier,
    systemPrompt: DISCOVERY_RANK_PROMPT,
    userPrompt: `Goal: "${input.goal}"\n\nAvailable feed items:\n${JSON.stringify(feedMeta, null, 2)}\n\nRank by relevance. Return structured JSON only.`,
    schema: DiscoveryRankSchema,
  });

  // Build ranked results — use LLM ranking if available, else fallback to recency
  const feedMap = new Map(allActive.map(f => [f.id as string, f]));
  let rankedItems: { feedItem: Record<string, unknown>; rank: number; reason: string; relevanceScore: number }[];

  if (rankResult.ok) {
    rankedItems = rankResult.data.ranked_sources
      .filter(r => feedMap.has(r.feed_item_id))
      .map((r, i) => ({
        feedItem: feedMap.get(r.feed_item_id)!,
        rank: i + 1,
        reason: r.reason,
        relevanceScore: r.relevance_score,
      }));
  } else {
    // Fallback: recency order, no LLM
    rankedItems = allActive.slice(0, 10).map((item, i) => ({
      feedItem: item,
      rank: i + 1,
      reason: "Recent feed item (LLM ranking unavailable)",
      relevanceScore: 0,
    }));
  }

  // Classify each item
  const classified = rankedItems.map(r => ({
    ...r,
    ...classifyItem(r.feedItem),
  }));

  const eligibleMonetized = classified.filter(c => c.claim_status === "verified" && c.is_monetized);
  const unclaimed = classified.filter(c => c.claim_status !== "verified" || !c.is_monetized);

  // Persist discovery run
  const { data: runRow, error: runErr } = await supabaseAdmin()
    .from("paylabs_discovery_runs")
    .insert({
      user_wallet: input.userWallet.toLowerCase(),
      goal: input.goal,
      route_tier: input.routeTier,
      status: eligibleMonetized.length > 0 ? "paid_path_available" : "discovery_only",
      candidate_count: allActive.length,
      eligible_source_count: eligibleMonetized.length,
      unclaimed_source_count: unclaimed.length,
      payment_kind: "discovery_fee",
      message: "PayLabs charges a discovery fee for AI-powered source routing. Creator payouts begin after ownership is verified.",
      agent_trace: {
        llm_ranking: rankResult.ok ? rankResult.meta : { error: rankResult.error },
        fallback: !rankResult.ok,
      },
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    return {
      status: "failed" as const,
      discoveryRunId: undefined,
      candidateCount: allActive.length,
      eligibleSourceCount: eligibleMonetized.length,
      unclaimedSourceCount: unclaimed.length,
      unclaimedSources: [],
      error: `Failed to persist discovery run: ${runErr?.message}`,
    };
  }

  // Persist discovery run items (unclaimed only — verified go through paid path)
  if (unclaimed.length > 0) {
    const items = unclaimed.map(c => ({
      discovery_run_id: runRow.id,
      feed_item_id: c.feedItem.id as string,
      source_url: String(c.feedItem.canonical_url || ""),
      source_title: String(c.feedItem.title || ""),
      publisher: String(c.feedItem.publisher || ""),
      claim_status: c.claim_status,
      is_monetized: c.is_monetized,
      evidence_score: c.relevanceScore || null,
      marginal_value_score: null,
      rank_index: c.rank,
      reason: c.reason,
    }));

    const { error: itemsErr } = await supabaseAdmin()
      .from("paylabs_discovery_run_items")
      .insert(items);

    if (itemsErr) {
      console.error("[discoverOnly] Failed to persist items:", itemsErr.message);
      // Non-fatal — run was created, items just missing
    }
  }

  // Build unclaimed_sources response (no wallet, no prices)
  const unclaimedSources = unclaimed.map(c => ({
    title: String(c.feedItem.title || ""),
    publisher: String(c.feedItem.publisher || ""),
    canonical_url: String(c.feedItem.canonical_url || ""),
    claim_status: c.claim_status,
    is_monetized: false,
    evidence_score: c.relevanceScore || null,
    reason: c.reason,
  }));

  return {
    status: eligibleMonetized.length > 0 ? "paid_path_available" as const : "discovery_only" as const,
    discoveryRunId: runRow.id,
    candidateCount: allActive.length,
    eligibleSourceCount: eligibleMonetized.length,
    unclaimedSourceCount: unclaimed.length,
    unclaimedSources,
    agentTrace: rankResult.ok ? rankResult.meta : { error: rankResult.error },
  };
}

// ─── Payment Graph (4 nodes) ────────────────────────────────────
// All 4 are free/internal LLM agents.
// Final decisions are deterministic (adapter executes, not LLM).

const sourcePaymentGraph = new StateGraph(PayLabsTutorState)
  // free: LLM for explanation, final allow/block is deterministic
  .addNode("policy_guard", policyGuardAgent)
  // free: LLM for explanation, quote value is deterministic from DB
  .addNode("payment_quote", paymentQuoteAgent)
  // free: LLM for explanation, actual execution is deterministic via adapter
  .addNode("payment_executor", paymentExecutorAgent)
  // free: LLM for audit summary, receipt status is deterministic from DB
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
  discoveryRunId?: string;
  paidReceiptIds?: Record<string, string>;
}) {
  const tier: RouteTier = input.routeTier || "normal";
  const config = getRouteConfig(tier);
  const limits = getRouteLimits(tier);
  const effectiveCap = computeEffectiveSpendCap(input.budgetUsdc, tier);

  // ── Deterministic pre-check: skip pipeline if no discoverable sources ──
  const { listDiscoverableFeedItems } = await import("./tools");
  const discoverableSources = await listDiscoverableFeedItems();
  if (discoverableSources.length === 0) {
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
      stopReason: "no_discoverable_sources",
      stopLimitHit: false,
      estimatedTotalUsdc: 0,
      estimatedCreatorPayoutUsdc: 0,
      estimatedAgentFeeUsdc: 0,
      estimatedTreasuryFeeUsdc: 0,
      remainingUsdc: 0,
      agentServiceCalls: [],
      agentTrace: { pre_check: "no_discoverable_sources" },
      error: "No discoverable sources found for this goal",
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
    discoveryRunId: input.discoveryRunId,
    paidReceiptIds: input.paidReceiptIds,
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
    eligibleSourceCount: discoverableSources.length,
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
