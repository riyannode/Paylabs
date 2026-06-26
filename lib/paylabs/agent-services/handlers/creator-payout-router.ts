/**
 * Creator Payout Router Handler
 *
 * Executes deterministic creator/bot/service payouts.
 * No LLM. Deterministic split. Validates all amounts in atomic units.
 *
 * Uses payout-executor.ts for real server-side x402/DCW/Gateway transfers.
 * Only marks paid/gateway_accepted if real payment transport returns metadata.
 * No fake tx or settlement IDs.
 */

import type {
  ServiceHandlerInput,
  ServiceHandlerOutput,
} from "../types";
import { buildCreatorSplitPlan } from "../../creator-distribution/split-policy";
import {
  executeCreatorPayouts,
  executeBotRevenueShare,
  executeServiceRevenueShare,
  type CreatorPaymentTransport,
} from "../../creator-distribution/payout-executor";
import type {
  CreatorAttribution,
  CreatorPayoutResult,
  AdvancedEvidenceEvaluatorOutput,
} from "../../creator-distribution/types";

export async function creatorPayoutRouterHandler(
  input: ServiceHandlerInput
): Promise<ServiceHandlerOutput> {
  const payload = input.payload as {
    creator_attributions?: CreatorAttribution[];
    selected_creator_items?: CreatorAttribution[];
    advanced_evaluator_output?: AdvancedEvidenceEvaluatorOutput | null;
    routeTier?: string;
    bot_wallet?: string;
    service_wallet?: string;
    transport?: CreatorPaymentTransport;
  };

  const routeTier = (payload.routeTier || "normal") as "easy" | "normal" | "advanced";
  const selectedItems = payload.selected_creator_items || [];
  const botWallet = payload.bot_wallet || process.env.PAYLABS_BOT_REVENUE_WALLET_ADDRESS || "";
  const serviceWallet = payload.service_wallet || process.env.PAYLABS_SERVICE_REVENUE_WALLET_ADDRESS || "";

  // Build deterministic split plan
  const splitPlan = buildCreatorSplitPlan({
    routeTier,
    selectedCreatorItems: selectedItems,
    botWallet,
    serviceWallet,
  });

  // If no transport provided, return planned-only results
  if (!payload.transport) {
    return {
      ok: true,
      serviceName: "creator_payout_router",
      data: {
        creator_payout_results: splitPlan.creator_items.map((item) => ({
          feed_item_id: item.feed_item_id,
          source_url: item.source_url,
          creator_wallet: item.creator_wallet,
          amount_atomic: item.creator_amount_atomic.toString(),
          amount_usdc: item.creator_amount_usdc,
          status: "pending",
          settlement_id: null,
          settlement_url: null,
          tx_hash: null,
          explorer_url: null,
          batch_tx_hash: null,
          batch_explorer_url: null,
          error: "no_payment_transport",
        })),
        bot_share_result: {
          status: "pending",
          amount_atomic: splitPlan.bot_atomic.toString(),
          amount_usdc: Number(splitPlan.bot_atomic) / 1e6,
        },
        service_share_result: {
          status: "pending",
          amount_atomic: splitPlan.service_atomic.toString(),
          amount_usdc: Number(splitPlan.service_atomic) / 1e6,
        },
        split_plan: {
          route_tier: splitPlan.route_tier,
          payout_limit: splitPlan.payout_limit,
          planned_creator_pool_atomic: splitPlan.planned_creator_pool_atomic.toString(),
          actual_creator_pool_atomic: splitPlan.actual_creator_pool_atomic.toString(),
          pending_creator_reserve_atomic: splitPlan.pending_creator_reserve_atomic.toString(),
        },
        pending_creator_reserve: Number(splitPlan.pending_creator_reserve_atomic) / 1e6,
        safe_summary: `Creator payout planned: ${splitPlan.creator_items.length} creators, pending transport.`,
      },
      safeSummary: `Creator payout router: ${splitPlan.creator_items.length} creators planned, no transport available.`,
      settled: false,
      error: null,
    };
  }

  // Execute real payouts
  const transport = payload.transport;

  const creatorResults = await executeCreatorPayouts({
    discoveryRunId: input.discoveryRunId,
    splitPlan,
    transport,
  });

  const botResult = await executeBotRevenueShare({
    discoveryRunId: input.discoveryRunId,
    amountAtomic: splitPlan.bot_atomic,
    botWalletAddress: botWallet,
    transport,
  });

  const serviceResult = await executeServiceRevenueShare({
    discoveryRunId: input.discoveryRunId,
    amountAtomic: splitPlan.service_atomic,
    serviceWalletAddress: serviceWallet,
    transport,
  });

  const paidCount = creatorResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted"
  ).length;

  return {
    ok: true,
    serviceName: "creator_payout_router",
    data: {
      creator_payout_results: creatorResults,
      bot_share_result: botResult,
      service_share_result: serviceResult,
      split_plan: {
        route_tier: splitPlan.route_tier,
        payout_limit: splitPlan.payout_limit,
        planned_creator_pool_atomic: splitPlan.planned_creator_pool_atomic.toString(),
        actual_creator_pool_atomic: splitPlan.actual_creator_pool_atomic.toString(),
        pending_creator_reserve_atomic: splitPlan.pending_creator_reserve_atomic.toString(),
      },
      pending_creator_reserve:
        Number(splitPlan.pending_creator_reserve_atomic) / 1e6,
      safe_summary: `Creator payout: ${paidCount}/${splitPlan.creator_items.length} paid, bot=${botResult.status}, service=${serviceResult.status}.`,
    },
    safeSummary: `Creator payout router: ${paidCount}/${splitPlan.creator_items.length} creators paid.`,
    settled: paidCount > 0,
    error: null,
  };
}
