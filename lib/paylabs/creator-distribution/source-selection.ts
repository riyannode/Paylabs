/**
 * Creator Source Selection
 *
 * Deterministic selection of creator sources for payout.
 * LLM must NOT choose who gets paid.
 * Deep Agent evaluator can explain and evaluate selected sources.
 * Payout selection remains deterministic.
 *
 * Algorithm:
 * 1. Filter eligible creator attributions
 * 2. Sort by: final_score desc → risk_score asc → quality_score desc → value_score desc → feed_item_id asc
 * 3. Take creator_payout_limit by tier
 */

import type {
  CreatorAttribution,
  CreatorPayoutTier,
} from "./types";

// ─── Payout Limits by Tier ────────────────────────────────────

export const CREATOR_PAYOUT_LIMIT_BY_TIER: Record<CreatorPayoutTier, number> =
  {
    easy: 0,
    normal: 1,
    advanced: 2,
  } as const;

// ─── Deterministic Selection ──────────────────────────────────

/**
 * Select creator sources for payout deterministically.
 *
 * @param routeTier - The current tier (easy/normal/advanced)
 * @param attributions - All creator attributions from claim-policy
 * @returns Selected attributions for payout (up to tier limit)
 */
export function selectCreatorPayoutItems(
  routeTier: CreatorPayoutTier,
  attributions: CreatorAttribution[]
): CreatorAttribution[] {
  const limit = CREATOR_PAYOUT_LIMIT_BY_TIER[routeTier];

  // Easy tier: no creator payout
  if (limit === 0) return [];

  // Filter eligible only
  const eligible = attributions.filter(
    (a) => a.eligibility_status === "eligible"
  );

  // Deterministic sort:
  // 1. final_score desc (higher is better)
  // 2. risk_score asc (lower risk is better)
  // 3. feed_item_id asc (stable tiebreaker)
  const sorted = [...eligible].sort((a, b) => {
    // Primary: final_score descending
    if (b.final_score !== a.final_score) {
      return b.final_score - a.final_score;
    }
    // Secondary: risk_score ascending
    if (a.risk_score !== b.risk_score) {
      return a.risk_score - b.risk_score;
    }
    // Tertiary: feed_item_id ascending (stable)
    return a.feed_item_id.localeCompare(b.feed_item_id);
  });

  // Take up to limit
  return sorted.slice(0, limit);
}
