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
 * The 15-agent LangGraph uses internal tiers (normal/advanced/premium).
 * The 7-agent nanopayment lane uses external tiers (easy/normal/advanced).
 * This module bridges the two without renaming the whole codebase.
 */

import type { RouteTier } from "@/lib/ai-tutor/route-config";

/** External tier names used in nanopayment API surface */
export type ExternalRouteTier = "easy" | "normal" | "advanced";

/** Internal tier names used by 15-agent LangGraph */
export type InternalRouteTier = RouteTier; // "normal" | "advanced" | "premium"

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

// ─── Discovery Fee Tiers ────────────────────────────────────────

export interface DiscoveryFeeTier {
  tier: ExternalRouteTier;
  userPaysUsdc: string;
  agentNanopaymentsUsdc: string;
  gatewayBufferUsdc: string;
  treasuryFeeUsdc: string;
  maxSourceCandidates: number;
  settlementMode: "nano" | "batch";
}

export const DISCOVERY_FEE_TIERS: Record<
  ExternalRouteTier,
  DiscoveryFeeTier
> = {
  easy: {
    tier: "easy",
    userPaysUsdc: "0.001000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000050",
    treasuryFeeUsdc: "0.000943",
    maxSourceCandidates: 5,
    settlementMode: "nano",
  },
  normal: {
    tier: "normal",
    userPaysUsdc: "0.002000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000100",
    treasuryFeeUsdc: "0.001893",
    maxSourceCandidates: 10,
    settlementMode: "batch",
  },
  advanced: {
    tier: "advanced",
    userPaysUsdc: "0.003000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000150",
    treasuryFeeUsdc: "0.002843",
    maxSourceCandidates: 15,
    settlementMode: "batch",
  },
};

/**
 * Get discovery fee tier config.
 * Falls back to easy if invalid.
 */
export function getDiscoveryFeeTier(
  tier: string
): DiscoveryFeeTier {
  if (tier in DISCOVERY_FEE_TIERS) {
    return DISCOVERY_FEE_TIERS[tier as ExternalRouteTier];
  }
  return DISCOVERY_FEE_TIERS.easy;
}
