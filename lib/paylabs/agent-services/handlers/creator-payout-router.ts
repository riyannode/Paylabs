/**
 * Creator Payout Router Handler
 *
 * Executes deterministic creator/bot/service payouts with ledger idempotency.
 * No LLM. Deterministic split. Validates all amounts in atomic units.
 *
 * Claim-before-transfer pattern:
 * 1. Claim pending ledger row FIRST (idempotent via unique constraint)
 * 2. If already completed (paid/gateway_accepted) → skip transfer
 * 3. If already pending → fail closed (concurrent claim)
 * 4. Execute x402 ONLY after successful pending claim
 * 5. Update ledger with real payment result
 * 6. Also write to legacy paylabs_creator_payout_events for reader compat
 *
 * No fake tx/ref/status. No raw secrets.
 */

import type {
  ServiceHandlerInput,
  ServiceHandlerOutput,
} from "../types";
import { buildCreatorSplitPlan, buildRevenueShareForPaidCreatorCount } from "../../creator-distribution/split-policy";
import {
  executeBotRevenueShare,
  executeServiceRevenueShare,
  writeCreatorPayoutEvent,
} from "../../creator-distribution/payout-executor";
import { createCreatorPaymentTransport } from "../../creator-distribution/transport";
import {
  claimPending,
  markPayoutResult,
  deleteLedgerRow,
  recordUnallocatedReserve,
  getExistingPayout,
} from "../../creator-distribution/payout-ledger";
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
    const { getDcwSigner, createDcwSigner, setDcwSigner } = await import("@/lib/paylabs/x402/dcw-signer-adapter");
    if (!getDcwSigner()) {
      const signer = createDcwSigner();
      setDcwSigner(signer);
    }
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

  // ── Creator payouts: claim-before-transfer ──
  const creatorResults: CreatorPayoutResult[] = [];

  for (const item of splitPlan.creator_items) {
    const subjectId = item.feed_item_id;

    // Validate wallet before claiming
    if (!item.creator_wallet || !/^0x[0-9a-fA-F]{40}$/.test(item.creator_wallet)) {
      creatorResults.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: "failed",
        settlement_id: null,
        settlement_url: null,
        tx_hash: null,
        explorer_url: null,
        batch_tx_hash: null,
        batch_explorer_url: null,
        error: "invalid_creator_wallet",
      });
      continue;
    }

    // Claim pending ledger slot
    const claim = await claimPending({
      discoveryRunId: input.discoveryRunId,
      payoutType: "creator_share",
      payoutSubjectId: subjectId,
      amountAtomic: item.creator_amount_atomic.toString(),
      amountUsdc: item.creator_amount_usdc,
      walletAddress: item.creator_wallet,
      routeTier,
      safeMetadata: {
        source_url: item.source_url,
        split_index: item.split_index,
        split_reason: item.split_reason,
      },
    });

    if (!claim.ok) {
      // Concurrent claim or error — fail closed, no transfer
      creatorResults.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: "failed",
        settlement_id: null,
        settlement_url: null,
        tx_hash: null,
        explorer_url: null,
        batch_tx_hash: null,
        batch_explorer_url: null,
        error: claim.error || "ledger_claim_failed",
      });
      continue;
    }

    // Already completed — skip transfer, return existing result
    if (claim.action === "already_completed" && claim.row) {
      creatorResults.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: claim.row.status as CreatorPayoutResult["status"],
        settlement_id: claim.row.settlement_id,
        settlement_url: claim.row.settlement_url,
        tx_hash: claim.row.tx_hash,
        explorer_url: claim.row.explorer_url,
        batch_tx_hash: claim.row.batch_tx_hash,
        batch_explorer_url: claim.row.batch_explorer_url,
        error: claim.row.error,
      });
      continue;
    }

    // Claimed — execute real x402 transfer (wrapped in try/catch)
    // If transport throws after claim, mark ledger as failed so retries can reclaim.
    let paymentResult: {
      ok: boolean;
      status: "paid" | "gateway_accepted" | "pending" | "failed";
      settlementId?: string | null;
      settlementUrl?: string | null;
      txHash?: string | null;
      explorerUrl?: string | null;
      batchTxHash?: string | null;
      batchExplorerUrl?: string | null;
      error?: string | null;
    };

    try {
      paymentResult = await transport.transfer({
        toAddress: item.creator_wallet,
        amountAtomic: item.creator_amount_atomic.toString(),
        metadata: {
          discovery_run_id: input.discoveryRunId,
          source_url: item.source_url,
          payment_type: "creator_distribution",
          split_index: String(item.split_index),
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Transport threw — mark ledger as failed so retry can reclaim
      await markPayoutResult({
        discoveryRunId: input.discoveryRunId,
        payoutType: "creator_share",
        payoutSubjectId: subjectId,
        status: "failed",
        error: `transport_exception: ${msg}`,
      });
      creatorResults.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: "failed",
        settlement_id: null,
        settlement_url: null,
        tx_hash: null,
        explorer_url: null,
        batch_tx_hash: null,
        batch_explorer_url: null,
        error: `transport_exception: ${msg}`,
      });
      continue;
    }

    // Map "pending" transport status to "failed" for ledger (pending is not a valid final state)
    const ledgerStatus = paymentResult.status === "pending" ? "failed" : paymentResult.status;

    // Update ledger with real result — check return
    const markResult = await markPayoutResult({
      discoveryRunId: input.discoveryRunId,
      payoutType: "creator_share",
      payoutSubjectId: subjectId,
      status: ledgerStatus,
      settlementId: paymentResult.settlementId,
      settlementUrl: paymentResult.settlementUrl,
      txHash: paymentResult.txHash,
      explorerUrl: paymentResult.explorerUrl,
      batchTxHash: paymentResult.batchTxHash,
      batchExplorerUrl: paymentResult.batchExplorerUrl,
      error: paymentResult.error,
    });

    if (!markResult.ok) {
      // Ledger write failed after real transfer — surface error
      console.error("[creator-payout-router] ledger mark failed after transfer:", markResult.error);
      creatorResults.push({
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: "failed",
        settlement_id: paymentResult.settlementId ?? null,
        settlement_url: paymentResult.settlementUrl ?? null,
        tx_hash: paymentResult.txHash ?? null,
        explorer_url: paymentResult.explorerUrl ?? null,
        batch_tx_hash: paymentResult.batchTxHash ?? null,
        batch_explorer_url: paymentResult.batchExplorerUrl ?? null,
        error: `ledger_mark_failed: ${markResult.error}`,
      });
      continue;
    }

    // Write to legacy events table for reader backward compat
    await writeCreatorPayoutEvent({
      discoveryRunId: input.discoveryRunId,
      routeTier,
      result: {
        feed_item_id: item.feed_item_id,
        source_url: item.source_url,
        creator_wallet: item.creator_wallet,
        amount_atomic: item.creator_amount_atomic.toString(),
        amount_usdc: item.creator_amount_usdc,
        status: paymentResult.status,
        settlement_id: paymentResult.settlementId ?? null,
        settlement_url: paymentResult.settlementUrl ?? null,
        tx_hash: paymentResult.txHash ?? null,
        explorer_url: paymentResult.explorerUrl ?? null,
        batch_tx_hash: paymentResult.batchTxHash ?? null,
        batch_explorer_url: paymentResult.batchExplorerUrl ?? null,
        error: paymentResult.error ?? null,
      },
      splitPolicy: "creator_split_v1_85_10_5",
    });

    creatorResults.push({
      feed_item_id: item.feed_item_id,
      source_url: item.source_url,
      creator_wallet: item.creator_wallet,
      amount_atomic: item.creator_amount_atomic.toString(),
      amount_usdc: item.creator_amount_usdc,
      status: paymentResult.status,
      settlement_id: paymentResult.settlementId ?? null,
      settlement_url: paymentResult.settlementUrl ?? null,
      tx_hash: paymentResult.txHash ?? null,
      explorer_url: paymentResult.explorerUrl ?? null,
      batch_tx_hash: paymentResult.batchTxHash ?? null,
      batch_explorer_url: paymentResult.batchExplorerUrl ?? null,
      error: paymentResult.error ?? null,
    });
  }

  // ── Bot/service shares: only for paid creators ──
  const paidCreatorResults = creatorResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted",
  );

  const revenueShare = buildRevenueShareForPaidCreatorCount({
    paidCreatorCount: paidCreatorResults.length,
  });

  // Bot share — claim-before-transfer
  // Fix 4: If paid count changed on retry, delete stale bot share row and re-claim
  let botResult: {
    status: string;
    amount_atomic: string;
    amount_usdc: number;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  } = {
    status: "skipped",
    amount_atomic: revenueShare.bot_atomic.toString(),
    amount_usdc: Number(revenueShare.bot_atomic) / 1e6,
    settlement_id: null,
    tx_hash: null,
    explorer_url: null,
    error: null,
  };

  if (revenueShare.bot_atomic > BigInt(0) && botWallet) {
    // Check if existing bot share has a different amount (paid count changed on retry)
    const existingBot = await getExistingPayout(input.discoveryRunId, "bot_share", "platform_bot");
    if (existingBot && existingBot.status !== "paid" && existingBot.status !== "gateway_accepted") {
      const existingAmount = BigInt(existingBot.amount_atomic);
      if (existingAmount !== revenueShare.bot_atomic) {
        // Amount changed — delete stale row so we can re-claim with correct amount
        await deleteLedgerRow(input.discoveryRunId, "bot_share", "platform_bot");
      }
    }

    const botClaim = await claimPending({
      discoveryRunId: input.discoveryRunId,
      payoutType: "bot_share",
      payoutSubjectId: "platform_bot",
      amountAtomic: revenueShare.bot_atomic.toString(),
      amountUsdc: Number(revenueShare.bot_atomic) / 1e6,
      walletAddress: botWallet,
      routeTier,
    });

    if (botClaim.ok && botClaim.action === "already_completed" && botClaim.row) {
      botResult = {
        status: botClaim.row.status,
        amount_atomic: botClaim.row.amount_atomic,
        amount_usdc: botClaim.row.amount_usdc,
        settlement_id: botClaim.row.settlement_id,
        tx_hash: botClaim.row.tx_hash,
        explorer_url: botClaim.row.explorer_url,
        error: botClaim.row.error,
      };
    } else if (botClaim.ok && botClaim.action === "claimed") {
      try {
        const execResult = await executeBotRevenueShare({
          discoveryRunId: input.discoveryRunId,
          amountAtomic: revenueShare.bot_atomic,
          botWalletAddress: botWallet,
          transport,
        });

        const markRes = await markPayoutResult({
          discoveryRunId: input.discoveryRunId,
          payoutType: "bot_share",
          payoutSubjectId: "platform_bot",
          status: execResult.status === "gateway_accepted" ? "gateway_accepted" : execResult.status === "paid" ? "paid" : "failed",
          settlementId: execResult.settlement_id,
          txHash: execResult.tx_hash,
          explorerUrl: execResult.explorer_url,
          error: execResult.error,
        });

        if (!markRes.ok) {
          console.error("[creator-payout-router] bot share ledger mark failed:", markRes.error);
          botResult = {
            status: "failed",
            amount_atomic: revenueShare.bot_atomic.toString(),
            amount_usdc: Number(revenueShare.bot_atomic) / 1e6,
            settlement_id: execResult.settlement_id ?? null,
            tx_hash: execResult.tx_hash ?? null,
            explorer_url: execResult.explorer_url ?? null,
            error: `bot_ledger_mark_failed: ${markRes.error}`,
          };
        } else {
          botResult = execResult;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await markPayoutResult({
          discoveryRunId: input.discoveryRunId,
          payoutType: "bot_share",
          payoutSubjectId: "platform_bot",
          status: "failed",
          error: `bot_transport_exception: ${msg}`,
        });
        botResult = {
          status: "failed",
          amount_atomic: revenueShare.bot_atomic.toString(),
          amount_usdc: Number(revenueShare.bot_atomic) / 1e6,
          settlement_id: null,
          tx_hash: null,
          explorer_url: null,
          error: `bot_transport_exception: ${msg}`,
        };
      }
    } else {
      botResult = {
        status: "failed",
        amount_atomic: revenueShare.bot_atomic.toString(),
        amount_usdc: Number(revenueShare.bot_atomic) / 1e6,
        settlement_id: null,
        tx_hash: null,
        explorer_url: null,
        error: botClaim.error || "bot_claim_failed",
      };
    }
  } else {
    // No paid creators — delete any stale bot share from prior failed attempt
    await deleteLedgerRow(input.discoveryRunId, "bot_share", "platform_bot");
  }

  // Service share — claim-before-transfer
  // Fix 4: Same pattern as bot share
  let serviceResult: {
    status: string;
    amount_atomic: string;
    amount_usdc: number;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  } = {
    status: "skipped",
    amount_atomic: revenueShare.service_atomic.toString(),
    amount_usdc: Number(revenueShare.service_atomic) / 1e6,
    settlement_id: null,
    tx_hash: null,
    explorer_url: null,
    error: null,
  };

  if (revenueShare.service_atomic > BigInt(0) && serviceWallet) {
    // Check if existing service share has a different amount (paid count changed on retry)
    const existingService = await getExistingPayout(input.discoveryRunId, "service_share", "platform_service");
    if (existingService && existingService.status !== "paid" && existingService.status !== "gateway_accepted") {
      const existingAmount = BigInt(existingService.amount_atomic);
      if (existingAmount !== revenueShare.service_atomic) {
        await deleteLedgerRow(input.discoveryRunId, "service_share", "platform_service");
      }
    }

    const serviceClaim = await claimPending({
      discoveryRunId: input.discoveryRunId,
      payoutType: "service_share",
      payoutSubjectId: "platform_service",
      amountAtomic: revenueShare.service_atomic.toString(),
      amountUsdc: Number(revenueShare.service_atomic) / 1e6,
      walletAddress: serviceWallet,
      routeTier,
    });

    if (serviceClaim.ok && serviceClaim.action === "already_completed" && serviceClaim.row) {
      serviceResult = {
        status: serviceClaim.row.status,
        amount_atomic: serviceClaim.row.amount_atomic,
        amount_usdc: serviceClaim.row.amount_usdc,
        settlement_id: serviceClaim.row.settlement_id,
        tx_hash: serviceClaim.row.tx_hash,
        explorer_url: serviceClaim.row.explorer_url,
        error: serviceClaim.row.error,
      };
    } else if (serviceClaim.ok && serviceClaim.action === "claimed") {
      try {
        const execResult = await executeServiceRevenueShare({
          discoveryRunId: input.discoveryRunId,
          amountAtomic: revenueShare.service_atomic,
          serviceWalletAddress: serviceWallet,
          transport,
        });

        const markRes = await markPayoutResult({
          discoveryRunId: input.discoveryRunId,
          payoutType: "service_share",
          payoutSubjectId: "platform_service",
          status: execResult.status === "gateway_accepted" ? "gateway_accepted" : execResult.status === "paid" ? "paid" : "failed",
          settlementId: execResult.settlement_id,
          txHash: execResult.tx_hash,
          explorerUrl: execResult.explorer_url,
          error: execResult.error,
        });

        if (!markRes.ok) {
          console.error("[creator-payout-router] service share ledger mark failed:", markRes.error);
          serviceResult = {
            status: "failed",
            amount_atomic: revenueShare.service_atomic.toString(),
            amount_usdc: Number(revenueShare.service_atomic) / 1e6,
            settlement_id: execResult.settlement_id ?? null,
            tx_hash: execResult.tx_hash ?? null,
            explorer_url: execResult.explorer_url ?? null,
            error: `service_ledger_mark_failed: ${markRes.error}`,
          };
        } else {
          serviceResult = execResult;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await markPayoutResult({
          discoveryRunId: input.discoveryRunId,
          payoutType: "service_share",
          payoutSubjectId: "platform_service",
          status: "failed",
          error: `service_transport_exception: ${msg}`,
        });
        serviceResult = {
          status: "failed",
          amount_atomic: revenueShare.service_atomic.toString(),
          amount_usdc: Number(revenueShare.service_atomic) / 1e6,
          settlement_id: null,
          tx_hash: null,
          explorer_url: null,
          error: `service_transport_exception: ${msg}`,
        };
      }
    } else {
      serviceResult = {
        status: "failed",
        amount_atomic: revenueShare.service_atomic.toString(),
        amount_usdc: Number(revenueShare.service_atomic) / 1e6,
        settlement_id: null,
        tx_hash: null,
        explorer_url: null,
        error: serviceClaim.error || "service_claim_failed",
      };
    }
  } else {
    // No paid creators — delete any stale service share from prior failed attempt
    await deleteLedgerRow(input.discoveryRunId, "service_share", "platform_service");
  }

  // ── Unallocated reserve ──
  // Fix 5: Clear stale reserve if unallocatedAtomic drops to 0 on retry
  // Fix 7: Distinguish eligibility vs failure reasons
  const paidCount = paidCreatorResults.length;
  const plannedPoolAtomic = splitPlan.planned_creator_pool_atomic;
  const paidPoolAtomic = BigInt(paidCount) * BigInt(20); // 20 atomic per slot
  const unallocatedAtomic = plannedPoolAtomic - paidPoolAtomic;

  if (unallocatedAtomic > BigInt(0)) {
    // Fix 7: Distinguish no-eligible, partial-eligibility, and payout-failed
    let reason: string;
    if (selectedItems.length === 0) {
      reason = "no_eligible_creator";
    } else if (paidCount === 0) {
      reason = "all_selected_creators_failed";
    } else if (selectedItems.length > paidCount) {
      reason = "partial_creator_payout_failed";
    } else {
      // paidCount < payout_limit but all selected items were paid
      reason = "partial_creator_eligibility";
    }

    await recordUnallocatedReserve({
      discoveryRunId: input.discoveryRunId,
      routeTier,
      amountAtomic: unallocatedAtomic.toString(),
      amountUsdc: Number(unallocatedAtomic) / 1e6,
      reason,
      safeMetadata: {
        planned_slots: splitPlan.payout_limit,
        paid_slots: paidCount,
        selected_items: selectedItems.length,
      },
    });
  } else {
    // Fix 5: unallocatedAtomic is 0 — clear any stale reserve row from prior failed attempt
    await deleteLedgerRow(input.discoveryRunId, "unallocated_reserve", "unallocated_reserve");
  }

  // ── Build output ──
  const creatorErrors = creatorResults
    .filter((r) => r.status === "failed")
    .map((r) => `[${r.feed_item_id}]: ${r.error}`);

  const botErrors = botResult.status === "failed" && botResult.error
    ? [`[bot_share]: ${botResult.error}`]
    : [];

  const serviceErrors = serviceResult.status === "failed" && serviceResult.error
    ? [`[service_share]: ${serviceResult.error}`]
    : [];

  const errorSummary = [...creatorErrors, ...botErrors, ...serviceErrors].join("; ");

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
    error: errorSummary || null,
  };
}
