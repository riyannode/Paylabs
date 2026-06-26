/**
 * Creator Payout Router Handler
 *
 * Executes deterministic creator/bot/service payouts.
 * No LLM. Deterministic split. Validates all amounts in atomic units.
 *
 * Uses payout-executor.ts for real server-side x402/DCW/Gateway transfers.
 * Transport is constructed server-side — never passed via JSON payload.
 * Only marks paid/gateway_accepted if real payment transport returns metadata.
 * No fake tx or settlement IDs.
 */

import type {
  ServiceHandlerInput,
  ServiceHandlerOutput,
} from "../types";
import { buildCreatorSplitPlan, buildRevenueShareForPaidCreatorCount } from "../../creator-distribution/split-policy";
import {
  executeCreatorPayouts,
  executeBotRevenueShare,
  executeServiceRevenueShare,
} from "../../creator-distribution/payout-executor";
import { createCreatorPaymentTransport } from "../../creator-distribution/transport";
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

  // Construct server-side transport — fail closed if unavailable
  let transport;
  try {
    transport = createCreatorPaymentTransport();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      serviceName: "creator_payout_router",
      data: {
        creator_payout_results: [],
        bot_share_result: null,
        service_share_result: null,
        split_plan: null,
        pending_creator_reserve: 0,
        safe_summary: `Creator payout transport failed: ${msg}`,
      },
      safeSummary: `Creator payout router: transport initialization failed.`,
      settled: false,
      error: `transport_init_failed: ${msg}`,
    };
  }

  // Execute real creator payouts
  const creatorResults = await executeCreatorPayouts({
    discoveryRunId: input.discoveryRunId,
    splitPlan,
    transport,
  });

  // Bot/service shares only for successful creator payouts
  const paidCreatorResults = creatorResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted",
  );

  const revenueShare = buildRevenueShareForPaidCreatorCount({
    paidCreatorCount: paidCreatorResults.length,
  });

  const botResult = await executeBotRevenueShare({
    discoveryRunId: input.discoveryRunId,
    amountAtomic: revenueShare.bot_atomic,
    botWalletAddress: botWallet,
    transport,
  });

  const serviceResult = await executeServiceRevenueShare({
    discoveryRunId: input.discoveryRunId,
    amountAtomic: revenueShare.service_atomic,
    serviceWalletAddress: serviceWallet,
    transport,
  });

  // Persist all payout events to DB — fail closed if any write fails
  const { writeCreatorPayoutEvent } = await import("../../creator-distribution/payout-executor");

  const eventWriteErrors: string[] = [];
  for (const result of creatorResults) {
    const writeResult = await writeCreatorPayoutEvent({
      discoveryRunId: input.discoveryRunId,
      routeTier,
      result,
      splitPolicy: "creator_split_v1_85_10_5",
    });
    if (!writeResult.ok) {
      eventWriteErrors.push(`[${result.feed_item_id}]: ${writeResult.error}`);
    }
  }

  if (eventWriteErrors.length > 0) {
    const errorSummary = `payout_event_write_failures: ${eventWriteErrors.length}/${creatorResults.length} events failed to persist`;
    console.error("[creator-payout-router]", errorSummary, eventWriteErrors);
    return {
      ok: false,
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
        safe_summary: `Creator payouts executed but ${eventWriteErrors.length} event(s) failed to persist. Audit trail incomplete.`,
      },
      safeSummary: `Creator payout router: ${eventWriteErrors.length} payout event(s) failed persistence.`,
      settled: false,
      error: errorSummary,
    };
  }

  const paidCount = paidCreatorResults.length;

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
