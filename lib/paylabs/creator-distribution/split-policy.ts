/**
 * Creator Split Policy
 *
 * Atomic-safe USDC split for creator/bot/service distribution.
 *
 * IMPORTANT: USDC has 6 decimals.
 * 0.000001 USDC = 1 atomic unit.
 * You cannot split 1 atomic unit into 85/10/5 on-chain.
 * So creator payout unit must be at least 20 atomic units.
 *
 * Exact split per creator slot (20 atomic):
 *   85% creator = 17 atomic = 0.000017 USDC
 *   10% bot     =  2 atomic = 0.000002 USDC
 *   5% service  =  1 atomic = 0.000001 USDC
 *
 * Normal (1 creator):
 *   creator_pool = 20 atomic, creator = 17, bot = 2, service = 1
 *
 * Advanced (2 creators):
 *   creator_pool = 40 atomic, creators = 34 (17 each), bot = 4, service = 2
 */

import type {
  CreatorPayoutTier,
  CreatorAttribution,
  CreatorPayoutPlanItem,
  CreatorSplitPlan,
} from "./types";

// ─── Constants ────────────────────────────────────────────────

export const USDC_DECIMALS = 6;
export const CREATOR_PAYOUT_UNIT_ATOMIC = BigInt(20);

/** Revenue split in basis points (10000 = 100%) */
export const CREATOR_REVENUE_SPLIT = {
  creatorBps: 8500, // 85%
  botBps: 1000, // 10%
  serviceBps: 500, // 5%
} as const;

/** Atomic units per creator slot breakdown */
export const SPLIT_PER_SLOT = {
  creator: BigInt(17), // 85% of 20
  bot: BigInt(2), // 10% of 20
  service: BigInt(1), // 5% of 20
} as const;

// ─── Helpers ──────────────────────────────────────────────────

export function getCreatorPayoutLimit(routeTier: CreatorPayoutTier): number {
  if (routeTier === "easy") return 0;
  if (routeTier === "normal") return 1;
  return 2;
}

export function getPlannedCreatorPoolAtomic(
  routeTier: CreatorPayoutTier
): bigint {
  return BigInt(getCreatorPayoutLimit(routeTier)) * CREATOR_PAYOUT_UNIT_ATOMIC;
}

// ─── Build Split Plan ─────────────────────────────────────────

export interface BuildCreatorSplitPlanInput {
  routeTier: CreatorPayoutTier;
  selectedCreatorItems: CreatorAttribution[];
  botWallet: string;
  serviceWallet: string;
}

/**
 * Build a deterministic creator split plan.
 * No LLM. Pure atomic math.
 *
 * Fails if:
 * - routeTier is easy and items are provided
 * - Any amount is not divisible by 20
 */
export function buildCreatorSplitPlan(
  input: BuildCreatorSplitPlanInput
): CreatorSplitPlan {
  const { routeTier, selectedCreatorItems, botWallet, serviceWallet } = input;
  const payoutLimit = getCreatorPayoutLimit(routeTier);

  // Fail closed: easy tier should never have creator items
  if (routeTier === "easy" && selectedCreatorItems.length > 0) {
    throw new Error(
      "creator_split_easy_tier_violation: easy tier must not have creator payout items"
    );
  }

  // Fail closed: more items than limit
  if (selectedCreatorItems.length > payoutLimit) {
    throw new Error(
      `creator_split_limit_exceeded: ${selectedCreatorItems.length} items exceeds tier limit ${payoutLimit}`
    );
  }

  const plannedCreatorPoolAtomic =
    BigInt(payoutLimit) * CREATOR_PAYOUT_UNIT_ATOMIC;
  const actualCreatorCount = selectedCreatorItems.length;
  const actualCreatorPoolAtomic =
    BigInt(actualCreatorCount) * CREATOR_PAYOUT_UNIT_ATOMIC;
  const pendingReserveAtomic =
    plannedCreatorPoolAtomic - actualCreatorPoolAtomic;

  // Build per-creator plan items (equal split: 17 atomic each)
  const creatorItems: CreatorPayoutPlanItem[] = selectedCreatorItems.map(
    (attr, index) => ({
      feed_item_id: attr.feed_item_id,
      source_url: attr.source_url,
      source_title: attr.source_title,
      creator_wallet: attr.creator_wallet!,
      creator_amount_atomic: SPLIT_PER_SLOT.creator,
      creator_amount_usdc: Number(SPLIT_PER_SLOT.creator) / 10 ** USDC_DECIMALS,
      split_index: index + 1,
      split_reason: `creator_slot_${index + 1}_of_${payoutLimit}`,
    })
  );

  // Bot and service share from ACTUAL paid pool only (not pending reserve)
  const botAtomic =
    BigInt(actualCreatorCount) * SPLIT_PER_SLOT.bot;
  const serviceAtomic =
    BigInt(actualCreatorCount) * SPLIT_PER_SLOT.service;

  return {
    route_tier: routeTier,
    payout_limit: payoutLimit,
    payout_unit_atomic: CREATOR_PAYOUT_UNIT_ATOMIC,
    planned_creator_pool_atomic: plannedCreatorPoolAtomic,
    actual_creator_pool_atomic: actualCreatorPoolAtomic,
    creator_total_atomic:
      BigInt(actualCreatorCount) * SPLIT_PER_SLOT.creator,
    bot_atomic: botAtomic,
    service_atomic: serviceAtomic,
    pending_creator_reserve_atomic: pendingReserveAtomic,
    creator_items: creatorItems,
    bot_wallet: botWallet,
    service_wallet: serviceWallet,
  };
}
