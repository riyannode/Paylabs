/**
 * Route Tier Reconcile
 *
 * Externally accepts: easy | normal | advanced
 * Internally maps:
 *   easy     → normal   (DB/internal tier)
 *   normal   → advanced (DB/internal tier)
 *   advanced → premium  (DB/internal tier)
 *
 * Default if missing: easy
 *
 * The delegated runtime uses external tiers (easy/normal/advanced).
 * The legacy 15-agent LangGraph used internal tiers (normal/advanced/premium).
 * This module bridges the two without renaming the whole codebase.
 */

/** External tier names used in delegated runtime API surface */
export type ExternalRouteTier = "easy" | "normal" | "advanced";

/** Internal tier names used by 15-agent LangGraph */
export type InternalRouteTier = "normal" | "advanced" | "premium";

/**
 * Backward-compatible internal route tier alias.
 * Legacy internal tier names are still normal/advanced/premium.
 */
export type RouteTier = InternalRouteTier;

const EXTERNAL_TO_INTERNAL: Record<ExternalRouteTier, InternalRouteTier> = {
  easy: "normal",
  normal: "advanced",
  advanced: "premium",
};

const INTERNAL_TO_EXTERNAL: Record<InternalRouteTier, ExternalRouteTier> = {
  normal: "easy",
  advanced: "normal",
  premium: "advanced",
};

export const DEFAULT_EXTERNAL_TIER: ExternalRouteTier = "easy";
export const DEFAULT_INTERNAL_TIER: InternalRouteTier = "normal";

/**
 * Convert external tier to internal.
 * Falls back to default if invalid.
 */
export function toInternalTier(external: string): InternalRouteTier {
  if (external in EXTERNAL_TO_INTERNAL) {
    return EXTERNAL_TO_INTERNAL[external as ExternalRouteTier];
  }
  return DEFAULT_INTERNAL_TIER;
}

/**
 * Convert internal tier to external.
 * Falls back to default if invalid.
 */
export function toExternalTier(internal: string): ExternalRouteTier {
  if (internal in INTERNAL_TO_EXTERNAL) {
    return INTERNAL_TO_EXTERNAL[internal as InternalRouteTier];
  }
  return DEFAULT_EXTERNAL_TIER;
}

/**
 * Validate external tier.
 */
export function isValidExternalTier(
  tier: string
): tier is ExternalRouteTier {
  return tier === "easy" || tier === "normal" || tier === "advanced";
}

// ─── Discovery Fee Tiers (removed — dead code, never imported)
// Actual pricing: quoteDelegatedRun() in quote-engine.ts
// Entry payment: buildCustomerEntryChallenge(quote.plannedCostUsdc)
