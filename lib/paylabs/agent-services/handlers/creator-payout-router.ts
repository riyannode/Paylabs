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
import { buildCreatorSplitPlan, SPLIT_PER_SLOT } from "../../creator-distribution/split-policy";
import {
  writeCreatorPayoutEvent,
} from "../../creator-distribution/payout-executor";
import { createCreatorPaymentTransport } from "../../creator-distribution/transport";
import {
  claimPending,
  markPayoutResult,
  deleteLedgerRow,
  recordUnallocatedReserve,
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
      // Try to ensure legacy table has this row (best-effort, no second payout)
      const legacyCompat = await writeCreatorPayoutEvent({
        discoveryRunId: input.discoveryRunId,
        routeTier,
        result: {
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
        },
        splitPolicy: "creator_split_v1_85_10_5",
      });

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
        error: !legacyCompat.ok
          ? `legacy_compat_write_failed: ${legacyCompat.error}`
          : claim.row.error,
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
    const legacyWrite = await writeCreatorPayoutEvent({
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

    // Surface legacy write failure but DO NOT retry x402 (canonical ledger is source of truth)
    if (!legacyWrite.ok) {
      console.error("[creator-payout-router] legacy event write failed:", legacyWrite.error);
    }

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

  // ── Bot/service platform shares: per-creator, not cumulative ──
  // Each paid creator gets a separate bot (2 atomic) and service (1 atomic) ledger entry.
  // Keyed by feed_item_id so retries only pay the delta for newly-paid creators.
  const paidCreatorResults = creatorResults.filter(
    (r) => r.status === "paid" || r.status === "gateway_accepted",
  );

  const paidCount = paidCreatorResults.length;

  // Per-creator bot/service share tracking
  let botPaidAtomic = BigInt(0);
  let botFailedCount = 0;
  let servicePaidAtomic = BigInt(0);
  let serviceFailedCount = 0;

  for (const paidResult of paidCreatorResults) {
    const botSubjectId = `platform_bot:${paidResult.feed_item_id}`;
    const serviceSubjectId = `platform_service:${paidResult.feed_item_id}`;

    // ── Bot share for this creator ──
    if (botWallet) {
      const botClaim = await claimPending({
        discoveryRunId: input.discoveryRunId,
        payoutType: "bot_share",
        payoutSubjectId: botSubjectId,
        amountAtomic: SPLIT_PER_SLOT.bot.toString(),
        amountUsdc: Number(SPLIT_PER_SLOT.bot) / 1e6,
        walletAddress: botWallet,
        routeTier,
        safeMetadata: { feed_item_id: paidResult.feed_item_id },
      });

      if (botClaim.ok && botClaim.action === "already_completed") {
        // Already paid — count toward total
        if (botClaim.row && (botClaim.row.status === "paid" || botClaim.row.status === "gateway_accepted")) {
          botPaidAtomic += SPLIT_PER_SLOT.bot;
        }
      } else if (botClaim.ok && botClaim.action === "claimed") {
        try {
          const transferResult = await transport.transfer({
            toAddress: botWallet,
            amountAtomic: SPLIT_PER_SLOT.bot.toString(),
            metadata: {
              discovery_run_id: input.discoveryRunId,
              payment_type: "bot_revenue_share",
              feed_item_id: paidResult.feed_item_id,
            },
          });

          const ledgerStatus = transferResult.status === "pending" ? "failed"
            : transferResult.status === "gateway_accepted" ? "gateway_accepted"
            : transferResult.status === "paid" ? "paid" : "failed";

          const markRes = await markPayoutResult({
            discoveryRunId: input.discoveryRunId,
            payoutType: "bot_share",
            payoutSubjectId: botSubjectId,
            status: ledgerStatus as "paid" | "gateway_accepted" | "failed",
            settlementId: transferResult.settlementId,
            txHash: transferResult.txHash,
            explorerUrl: transferResult.explorerUrl,
            error: transferResult.error,
          });

          if (!markRes.ok) {
            console.error("[creator-payout-router] bot share ledger mark failed:", markRes.error);
            botFailedCount++;
          } else if (ledgerStatus === "paid" || ledgerStatus === "gateway_accepted") {
            botPaidAtomic += SPLIT_PER_SLOT.bot;
          } else {
            botFailedCount++;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          await markPayoutResult({
            discoveryRunId: input.discoveryRunId,
            payoutType: "bot_share",
            payoutSubjectId: botSubjectId,
            status: "failed",
            error: `bot_transport_exception: ${msg}`,
          });
          botFailedCount++;
        }
      } else {
        // Claim failed
        botFailedCount++;
      }
    }

    // ── Service share for this creator ──
    if (serviceWallet) {
      const serviceClaim = await claimPending({
        discoveryRunId: input.discoveryRunId,
        payoutType: "service_share",
        payoutSubjectId: serviceSubjectId,
        amountAtomic: SPLIT_PER_SLOT.service.toString(),
        amountUsdc: Number(SPLIT_PER_SLOT.service) / 1e6,
        walletAddress: serviceWallet,
        routeTier,
        safeMetadata: { feed_item_id: paidResult.feed_item_id },
      });

      if (serviceClaim.ok && serviceClaim.action === "already_completed") {
        if (serviceClaim.row && (serviceClaim.row.status === "paid" || serviceClaim.row.status === "gateway_accepted")) {
          servicePaidAtomic += SPLIT_PER_SLOT.service;
        }
      } else if (serviceClaim.ok && serviceClaim.action === "claimed") {
        try {
          const transferResult = await transport.transfer({
            toAddress: serviceWallet,
            amountAtomic: SPLIT_PER_SLOT.service.toString(),
            metadata: {
              discovery_run_id: input.discoveryRunId,
              payment_type: "service_revenue_share",
              feed_item_id: paidResult.feed_item_id,
            },
          });

          const ledgerStatus = transferResult.status === "pending" ? "failed"
            : transferResult.status === "gateway_accepted" ? "gateway_accepted"
            : transferResult.status === "paid" ? "paid" : "failed";

          const markRes = await markPayoutResult({
            discoveryRunId: input.discoveryRunId,
            payoutType: "service_share",
            payoutSubjectId: serviceSubjectId,
            status: ledgerStatus as "paid" | "gateway_accepted" | "failed",
            settlementId: transferResult.settlementId,
            txHash: transferResult.txHash,
            explorerUrl: transferResult.explorerUrl,
            error: transferResult.error,
          });

          if (!markRes.ok) {
            console.error("[creator-payout-router] service share ledger mark failed:", markRes.error);
            serviceFailedCount++;
          } else if (ledgerStatus === "paid" || ledgerStatus === "gateway_accepted") {
            servicePaidAtomic += SPLIT_PER_SLOT.service;
          } else {
            serviceFailedCount++;
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          await markPayoutResult({
            discoveryRunId: input.discoveryRunId,
            payoutType: "service_share",
            payoutSubjectId: serviceSubjectId,
            status: "failed",
            error: `service_transport_exception: ${msg}`,
          });
          serviceFailedCount++;
        }
      } else {
        serviceFailedCount++;
      }
    }
  }

  // Aggregate bot/service results
  const botResult: {
    status: string;
    amount_atomic: string;
    amount_usdc: number;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  } = {
    status: paidCount === 0 ? "skipped"
      : botFailedCount === 0 && botPaidAtomic > BigInt(0) ? "paid"
      : botPaidAtomic > BigInt(0) ? "partial"
      : "failed",
    amount_atomic: botPaidAtomic.toString(),
    amount_usdc: Number(botPaidAtomic) / 1e6,
    settlement_id: null, // Aggregated — per-creator details in ledger
    tx_hash: null,
    explorer_url: null,
    error: botFailedCount > 0 ? `${botFailedCount}/${paidCount} bot shares failed` : null,
  };

  const serviceResult: {
    status: string;
    amount_atomic: string;
    amount_usdc: number;
    settlement_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    error: string | null;
  } = {
    status: paidCount === 0 ? "skipped"
      : serviceFailedCount === 0 && servicePaidAtomic > BigInt(0) ? "paid"
      : servicePaidAtomic > BigInt(0) ? "partial"
      : "failed",
    amount_atomic: servicePaidAtomic.toString(),
    amount_usdc: Number(servicePaidAtomic) / 1e6,
    settlement_id: null,
    tx_hash: null,
    explorer_url: null,
    error: serviceFailedCount > 0 ? `${serviceFailedCount}/${paidCount} service shares failed` : null,
  };

  // ── Unallocated reserve ──
  // Fix 5: Clear stale reserve if unallocatedAtomic drops to 0 on retry
  // Fix 7: Distinguish eligibility vs failure reasons
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
        pending_creator_reserve_atomic: unallocatedAtomic.toString(),
      },
      pending_creator_reserve: Number(unallocatedAtomic) / 1e6,
      safe_summary: `Creator payout: ${paidCount}/${splitPlan.creator_items.length} paid, bot=${botResult.status}, service=${serviceResult.status}.`,
    },
    safeSummary: `Creator payout router: ${paidCount}/${splitPlan.creator_items.length} creators paid.`,
    settled: paidCount > 0,
    error: errorSummary || null,
  };
}
