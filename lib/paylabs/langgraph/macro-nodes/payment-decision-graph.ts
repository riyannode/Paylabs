/**
 * Payment Decision LangGraph
 *
 * Phase 2 of the delegated runtime.
 * Services: intent_matcher → source_verifier → value_allocator → trust_verifier → payment_decider
 *
 * Graph:
 *   START → intent_matcher → prepare_candidates → source_verifier →
 *   value_allocator → trust_verifier → payment_decider → build_summary → END
 *
 * Rules:
 * - LangGraph = internal execution orchestration ONLY
 * - Must NOT sign payments
 * - Must NOT settle payments
 * - Service nodes call callDelegatedService()
 * - Returns approvedItems + skippedItems + normal_summary
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { PaymentDecisionState, type PaymentDecisionStateType } from "../shared/state";
import { createServiceNode } from "../services/service-node";
import type { ServiceName } from "../../agent-services/types";
import type { BudgetSnapshot, SafeSourceCard } from "../../delegated-runtime/types";

// ─── Helper to cast state in payload functions ──────────────

function asDecisionState(state: Record<string, unknown>): PaymentDecisionStateType {
  return state as unknown as PaymentDecisionStateType;
}

// ─── Node: Intent Matcher ───────────────────────────────────

const intentMatcherNode = createServiceNode(
  "intent_matcher",
  "payment_decision",
  (state) => {
    const s = asDecisionState(state);
    return {
      normalized_goal: s.userGoal,
      candidates: (s.sourceCards || []).slice(0, 10).map((c, i) => ({
        feed_item_id: c.feed_item_id,
        title: c.title,
        publisher: c.publisher,
        rank: (i + 1),
      })),
      routeTier: s.routeTier,
    };
  },
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Prepare Candidates ───────────────────────────────

async function prepareCandidates(state: PaymentDecisionStateType) {
  const sourceCards = state.sourceCards || [];
  if (sourceCards.length === 0) {
    return {
      candidateMeta: [] as PaymentDecisionStateType["candidateMeta"],
      progressSummaries: ["Payment Decision: 0 discovery source cards to evaluate"],
    };
  }

  // Load feed items for metadata (wallet, price, claim status)
  const { getFeedItemById } = await import("../../../ai/tools");
  const { resolveVerifiedCreatorClaimForSource } = await import("../../creator-distribution/claim-resolver");

  const candidateMeta: PaymentDecisionStateType["candidateMeta"] = [];
  for (const card of sourceCards.slice(0, 10)) {
    // Skip DB lookup for live source IDs (rsshub_live:*, tavily_live:*)
    // These are synthetic IDs that don't exist in paylabs_feed_items.
    const isLiveSource = card.source_kind === "rsshub_live" ||
      card.source_kind === "tavily_live" ||
      card.feed_item_id.startsWith("rsshub_live:") ||
      card.feed_item_id.startsWith("tavily_live:");

    if (isLiveSource) {
      // Live sources: try to resolve verified creator claim by source URL/domain
      const resolvedClaim = await resolveVerifiedCreatorClaimForSource({
        sourceUrl: card.source_url || null,
      });

      if (resolvedClaim) {
        // Verified creator claim exists — this live source can be creator-payable
        candidateMeta.push({
          feed_item_id: card.feed_item_id,
          source_url: card.source_url || "",
          source_title: card.title || "",
          publisher: card.publisher || "",
          creator_wallet: resolvedClaim.creator_wallet,
          claim_status: "verified",
          source_kind: card.source_kind || (card.feed_item_id.startsWith("rsshub_live:") ? "rsshub_live" : "tavily_live"),
          is_live: false, // verified claim — eligible for creator payout
        });
      } else {
        // No verified claim — keep as non-monetized live source
        candidateMeta.push({
          feed_item_id: card.feed_item_id,
          source_url: card.source_url || "",
          source_title: card.title || "",
          publisher: card.publisher || "",
          creator_wallet: null,
          claim_status: "unclaimed",
          source_kind: card.source_kind || (card.feed_item_id.startsWith("rsshub_live:") ? "rsshub_live" : "tavily_live"),
          is_live: true,  // skip paid approval — no creator to pay
        });
      }
      continue;
    }

    // DB feed item: enrich via getFeedItemById
    let feedItem: Record<string, unknown> | null = null;
    try {
      feedItem = (await getFeedItemById(card.feed_item_id)) as Record<string, unknown> | null;
    } catch {
      // Feed item not found in DB — use card data as fallback
      feedItem = null;
    }

    // Read route verification from joined relation (not top-level feedItem.verification_status)
    const routeRaw = feedItem?.rsshub_route as unknown;
    const route = Array.isArray(routeRaw) ? (routeRaw[0] as Record<string, unknown> | undefined) : (routeRaw as Record<string, unknown> | undefined);
    const routeVerified = route?.verification_status === "verified" && route?.is_monetized === true;
    const routeCreatorWallet = route?.creator_wallet ? String(route.creator_wallet).toLowerCase() : null;
    const feedCreatorWallet = feedItem?.creator_wallet ? String(feedItem.creator_wallet).toLowerCase() : (card.creator_wallet || null);

    let creatorWallet: string | null = null;
    let claimStatus = "unclaimed";

    if (routeVerified && (routeCreatorWallet || feedCreatorWallet)) {
      // Route is verified + monetized
      creatorWallet = routeCreatorWallet || feedCreatorWallet;
      claimStatus = "verified";
    } else {
      // Fallback: resolve from paylabs_creator_claims
      const sourceUrl = String(feedItem?.canonical_url || card.source_url || "");
      const resolvedClaim = await resolveVerifiedCreatorClaimForSource({ sourceUrl });
      if (resolvedClaim) {
        creatorWallet = resolvedClaim.creator_wallet;
        claimStatus = "verified";
      } else {
        creatorWallet = feedCreatorWallet;
        claimStatus = String(card.claim_status || "unclaimed");
      }
    }

    candidateMeta.push({
      feed_item_id: card.feed_item_id,
      source_url: String(feedItem?.canonical_url || card.source_url || ""),
      source_title: String(feedItem?.title || card.title || ""),
      publisher: String(feedItem?.publisher || card.publisher || ""),
      creator_wallet: creatorWallet,
      claim_status: claimStatus,
    });
  }

  return {
    candidateMeta,
    progressSummaries: [`Payment Decision: prepared ${candidateMeta.length} candidates from ${sourceCards.length} source cards`],
  };
}

// ─── Node: Source Verifier (batch) ──────────────────────────

const sourceVerifierNode = createServiceNode(
  "source_verifier",
  "payment_decision",
  (state) => {
    const s = asDecisionState(state);
    return {
      candidates: (s.candidateMeta || []).map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        source_title: c.source_title,
      })),
      routeTier: s.routeTier,
    };
  },
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Process Source Verifier Result ───────────────────

async function processSourceVerifierResult(state: PaymentDecisionStateType) {
  const evals = state.serviceEvaluations || [];
  const verifyEval = evals.find((e) => e.serviceName === "source_verifier");

  const qualityScores: Record<string, number> = {};
  if (verifyEval?.output) {
    const results = verifyEval.output.results as Array<{ feed_item_id: string; quality_score: number }> | undefined;
    if (results) {
      for (const r of results) {
        qualityScores[r.feed_item_id] = r.quality_score;
      }
    }
  }

  return { qualityScores };
}

// ─── Node: Value Allocator (batch) ──────────────────────────

const valueAllocatorNode = createServiceNode(
  "value_allocator",
  "payment_decision",
  (state) => {
    const s = asDecisionState(state);
    return {
      candidates: (s.candidateMeta || []).map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        source_title: c.source_title,
        quality_score: (s.qualityScores || {})[c.feed_item_id] ?? 0,
      })),
      remaining_budget_usdc: s.budgetSnapshot?.remainingUsdc ?? s.userBudgetUsdc,
      routeTier: s.routeTier,
    };
  },
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Process Value Allocator Result ───────────────────

async function processValueAllocatorResult(state: PaymentDecisionStateType) {
  const evals = state.serviceEvaluations || [];
  const valueEval = evals.find((e) => e.serviceName === "value_allocator");

  const valueScores: Record<string, { roi: number; estimated_value: number; max_allowed_price: number }> = {};
  if (valueEval?.output) {
    const results = valueEval.output.results as Array<{
      feed_item_id: string;
      roi_score: number;
      estimated_value: number;
      max_allowed_price: number;
    }> | undefined;
    if (results) {
      for (const r of results) {
        valueScores[r.feed_item_id] = {
          roi: r.roi_score,
          estimated_value: r.estimated_value,
          max_allowed_price: r.max_allowed_price,
        };
      }
    }
  }

  return { valueScores };
}

// ─── Node: Trust Verifier (batch) ───────────────────────────

const trustVerifierNode = createServiceNode(
  "trust_verifier",
  "payment_decision",
  (state) => {
    const s = asDecisionState(state);
    return {
      candidates: (s.candidateMeta || []).map((c) => ({
        feed_item_id: c.feed_item_id,
        source_url: c.source_url,
        creator_wallet: c.creator_wallet,
        claim_status: c.claim_status,
      })),
      routeTier: s.routeTier,
    };
  },
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Process Trust Verifier Result ────────────────────

async function processTrustVerifierResult(state: PaymentDecisionStateType) {
  const evals = state.serviceEvaluations || [];
  const trustEval = evals.find((e) => e.serviceName === "trust_verifier");

  const riskScores: Record<string, number> = {};
  if (trustEval?.output) {
    const results = trustEval.output.results as Array<{ feed_item_id: string; risk_score: number }> | undefined;
    if (results) {
      for (const r of results) {
        riskScores[r.feed_item_id] = r.risk_score;
      }
    }
  }

  return { riskScores };
}

// ─── Node: Payment Decider (deterministic) ──────────────────

const paymentDeciderNode = createServiceNode(
  "payment_decider",
  "payment_decision",
  (state) => {
    const s = asDecisionState(state);
    const candidateMeta = s.candidateMeta || [];
    const qualityScores = s.qualityScores || {};
    const riskScores = s.riskScores || {};
    const valueScores = s.valueScores || {};

    const evaluations = candidateMeta.map((c) => ({
      feed_item_id: c.feed_item_id,
      source_url: c.source_url,
      source_title: c.source_title,
      quality_score: qualityScores[c.feed_item_id] ?? 0,
      risk_score: riskScores[c.feed_item_id] ?? 0.5,
      roi_score: valueScores[c.feed_item_id]?.roi ?? 0,
      estimated_value: valueScores[c.feed_item_id]?.estimated_value ?? 0,
      max_allowed_price: valueScores[c.feed_item_id]?.max_allowed_price ?? 0,
      creator_wallet: c.creator_wallet,
    }));

    return {
      evaluations,
      total_budget_usdc: s.budgetSnapshot?.totalBudgetUsdc ?? s.userBudgetUsdc,
      spent_usdc: s.budgetSnapshot?.spentUsdc ?? 0,
      routeTier: s.routeTier,
    };
  },
  { paymentLayer: "macro_to_child", paymentSchemeOverride: "circle_gateway_wallet_batched_per_child_fallback", required: true, skipIfNotSelected: false }
);

// ─── Node: Process Payment Decider Result ───────────────────

async function processPaymentDeciderResult(state: PaymentDecisionStateType) {
  const evals = state.serviceEvaluations || [];
  const deciderEval = evals.find((e) => e.serviceName === "payment_decider");

  if (!deciderEval?.output) {
    return {
      approvedItems: [] as PaymentDecisionStateType["approvedItems"],
      skippedItems: [] as PaymentDecisionStateType["skippedItems"],
      totalEstimatedSpend: 0,
      error: "Payment decider returned no output",
    };
  }

  const data = deciderEval.output as {
    approved_items?: Array<{
      feed_item_id: string;
      source_url: string;
      source_title: string;
      approved_price_usdc: number;
      final_score: number;
      risk_score: number;
      creator_wallet: string | null;
    }>;
    skipped_items?: Array<{
      feed_item_id: string;
      source_url: string;
      skip_reason: string;
    }>;
    total_estimated_spend?: number;
  };

  // Filter out live (non-monetized) sources from approved items — no creator to pay
  const candidateMeta = state.candidateMeta || [];
  const liveIds = new Set(
    candidateMeta.filter((c) => c.is_live).map((c) => c.feed_item_id)
  );

  const rawApproved = data.approved_items || [];
  const metaById = new Map(candidateMeta.map((m) => [m.feed_item_id, m]));

  const filteredApproved = rawApproved
    .filter((item) => !liveIds.has(item.feed_item_id))
    .map((item) => {
      const meta = metaById.get(item.feed_item_id);

      return {
        ...item,
        creator_wallet:
          item.creator_wallet ??
          meta?.creator_wallet ??
          null,
        claim_status:
          meta?.claim_status ??
          "unclaimed",
        publisher:
          meta?.publisher,
        source_kind:
          meta?.source_kind,
        is_live:
          meta?.is_live ?? false,
      };
    });
  const liveSkipped = rawApproved
    .filter((item) => liveIds.has(item.feed_item_id))
    .map((item) => ({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      skip_reason: "Live source — non-monetized, no creator wallet",
    }));

  return {
    approvedItems: filteredApproved,
    skippedItems: [...(data.skipped_items || []), ...liveSkipped],
    totalEstimatedSpend: filteredApproved.reduce((sum, i) => sum + (i.approved_price_usdc || 0), 0),
  };
}

// ─── Node: Build Normal Summary ─────────────────────────────

async function buildNormalSummary(state: PaymentDecisionStateType) {
  const approvedCount = state.approvedItems?.length || 0;
  const skippedCount = state.skippedItems?.length || 0;
  const totalSpend = state.totalEstimatedSpend || 0;
  const candidateCount = state.sourceCards?.length || state.candidates?.length || 0;

  let summary: string;
  if (candidateCount === 0) {
    summary = "Normal route had no discovery source cards to evaluate.";
  } else if (approvedCount === 0) {
    summary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. None passed the decision gate.`;
  } else {
    summary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. ${approvedCount} passed the decision gate and ${skippedCount} were skipped. Estimated approved spend: ${totalSpend.toFixed(6)} USDC.`;
  }

  return {
    progressSummaries: [summary],
  };
}

// ─── Graph Wiring ───────────────────────────────────────────

const graph = new StateGraph(PaymentDecisionState)
  // Service nodes
  .addNode("intent_matcher", intentMatcherNode)
  .addNode("prepare_candidates", prepareCandidates)
  .addNode("source_verifier", sourceVerifierNode)
  .addNode("process_source", processSourceVerifierResult)
  .addNode("value_allocator", valueAllocatorNode)
  .addNode("process_value", processValueAllocatorResult)
  .addNode("trust_verifier", trustVerifierNode)
  .addNode("process_trust", processTrustVerifierResult)
  .addNode("payment_decider", paymentDeciderNode)
  .addNode("process_decider", processPaymentDeciderResult)
  .addNode("build_summary", buildNormalSummary)
  // Edges
  .addEdge(START, "intent_matcher")
  .addEdge("intent_matcher", "prepare_candidates")
  .addEdge("prepare_candidates", "source_verifier")
  .addEdge("source_verifier", "process_source")
  .addEdge("process_source", "value_allocator")
  .addEdge("value_allocator", "process_value")
  .addEdge("process_value", "trust_verifier")
  .addEdge("trust_verifier", "process_trust")
  .addEdge("process_trust", "payment_decider")
  .addEdge("payment_decider", "process_decider")
  .addEdge("process_decider", "build_summary")
  .addEdge("build_summary", END)
  .compile();

// ─── Public API ─────────────────────────────────────────────

export interface RunPaymentDecisionGraphInput {
  discoveryRunId: string;
  userGoal: string;
  routeTier: "easy" | "normal" | "advanced";
  userBudgetUsdc: number;
  sourceCards: SafeSourceCard[];
  discoverySummary?: string;
  selectedServices?: ServiceName[];
  parentWalletId?: string;
}

export interface RunPaymentDecisionGraphOutput {
  ok: boolean;
  approvedItems: Array<{
    feed_item_id: string;
    source_url: string;
    source_title: string;
    approved_price_usdc: number;
    final_score: number;
    risk_score: number;
    creator_wallet: string | null;
  }>;
  skippedItems: Array<{
    feed_item_id: string;
    source_url: string;
    skip_reason: string;
  }>;
  totalEstimatedSpend: number;
  normalSummary: string;
  serviceEvaluations: PaymentDecisionStateType["serviceEvaluations"];
  paymentEdges: PaymentDecisionStateType["paymentEdges"];
  progressSummaries: string[];
  error: string | null;
}

/**
 * Run the Payment Decision graph (replaces plain async runner).
 */
export async function runPaymentDecisionGraph(
  input: RunPaymentDecisionGraphInput
): Promise<RunPaymentDecisionGraphOutput> {
  const initialBudget: BudgetSnapshot = {
    totalBudgetUsdc: input.userBudgetUsdc,
    spentUsdc: 0,
    remainingUsdc: input.userBudgetUsdc,
    serviceSpend: {} as Record<ServiceName, number>,
    settledServiceFeesUsdc: 0,
    estimatedServiceFeesUsdc: 0,
  };

  try {
    const result = await graph.invoke({
      discoveryRunId: input.discoveryRunId,
      userGoal: input.userGoal,
      routeTier: input.routeTier,
      userBudgetUsdc: input.userBudgetUsdc,
      sourceCards: input.sourceCards || [],
      discoverySummary: input.discoverySummary,
      selectedServices: input.selectedServices || [],
      parentWalletId: input.parentWalletId,
      budgetSnapshot: initialBudget,
      // Initialize
      intentMatchScore: 0,
      totalEstimatedSpend: 0,
      qualityScores: {},
      valueScores: {},
      riskScores: {},
      candidateMeta: [],
      candidates: [],
      approvedItems: [],
      skippedItems: [],
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [],
    });

    const approvedCount = result.approvedItems?.length || 0;
    const skippedCount = result.skippedItems?.length || 0;
    const totalSpend = result.totalEstimatedSpend || 0;
    const candidateCount = input.sourceCards.length;

    let normalSummary: string;
    if (candidateCount === 0) {
      normalSummary = "Normal route had no discovery source cards to evaluate.";
    } else if (approvedCount === 0) {
      normalSummary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. None passed the decision gate.`;
    } else {
      normalSummary = `Discovery produced ${candidateCount} source cards. Normal route evaluated them with intent, source quality, value, trust, and decision checks. ${approvedCount} passed the decision gate and ${skippedCount} were skipped. Estimated approved spend: ${totalSpend.toFixed(6)} USDC.`;
    }

    return {
      ok: !result.error,
      approvedItems: result.approvedItems || [],
      skippedItems: result.skippedItems || [],
      totalEstimatedSpend: totalSpend,
      normalSummary,
      serviceEvaluations: result.serviceEvaluations || [],
      paymentEdges: result.paymentEdges || [],
      progressSummaries: result.progressSummaries || [],
      error: result.error || null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      approvedItems: [],
      skippedItems: [],
      totalEstimatedSpend: 0,
      normalSummary: `Payment Decision failed: ${msg}`,
      serviceEvaluations: [],
      paymentEdges: [],
      progressSummaries: [`Payment Decision graph error: ${msg}`],
      error: msg,
    };
  }
}
