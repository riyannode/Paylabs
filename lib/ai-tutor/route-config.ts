/**
 * Route Tier Configuration
 * Defines behavior parameters for each route tier.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 *
 * Internal values (normal/advanced/premium) unchanged for DB compatibility.
 * Public labels: Easy / Normal / Advanced.
 *
 * Phase 3: Route spend limits, split rules, stop-limit thresholds.
 */

export type RouteTier = "normal" | "advanced" | "premium";

export interface RouteConfig {
  tier: RouteTier;
  label: string;
  publicLabel: string;
  maxSourceCards: number;
  reasoningDepth: "low" | "medium" | "high";
  sourceStrictness: "standard" | "high" | "very_high";
  plannerStyle: "quick_intro" | "builder_path" | "deep_mastery";
  description: string;
}

export const ROUTE_CONFIG: Record<RouteTier, RouteConfig> = {
  normal: {
    tier: "normal",
    label: "Normal Route",
    publicLabel: "Easy",
    maxSourceCards: 2,
    reasoningDepth: "low",
    sourceStrictness: "standard",
    plannerStyle: "quick_intro",
    description: "Cheapest and fastest source path. Standard verification.",
  },
  advanced: {
    tier: "advanced",
    label: "Advanced Route",
    publicLabel: "Normal",
    maxSourceCards: 5,
    reasoningDepth: "medium",
    sourceStrictness: "high",
    plannerStyle: "builder_path",
    description: "Balanced source path. Higher source strictness.",
  },
  premium: {
    tier: "premium",
    label: "Advanced Route",
    publicLabel: "Advanced",
    maxSourceCards: 8,
    reasoningDepth: "high",
    sourceStrictness: "very_high",
    plannerStyle: "deep_mastery",
    description: "Deep source/research path. Highest strictness.",
  },
} as const satisfies Record<RouteTier, RouteConfig>;

// ─── Route Spend Limits ─────────────────────────────────────────
// Stop-limit source allocation thresholds per route tier.

export interface RouteLimits {
  publicLabel: string;
  maxSources: number;
  maxPaidAgentCalls: number;
  creatorPayoutCapUsdc: number;
  actualSpendCapUsdc: number;
  minEvidenceScore: number;
  stopMarginalValueBelow: number;
  minUserBudgetUsdc: number;
}

export const ROUTE_LIMITS: Record<RouteTier, RouteLimits> = {
  normal: {
    publicLabel: "Easy",
    maxSources: 2,
    maxPaidAgentCalls: 1,
    creatorPayoutCapUsdc: 0.00005,
    actualSpendCapUsdc: 0.00006,
    minEvidenceScore: 0.72,
    stopMarginalValueBelow: 0.10,
    minUserBudgetUsdc: 0.0005,
  },
  advanced: {
    publicLabel: "Normal",
    maxSources: 5,
    maxPaidAgentCalls: 4,
    creatorPayoutCapUsdc: 0.00007,
    actualSpendCapUsdc: 0.00009,
    minEvidenceScore: 0.76,
    stopMarginalValueBelow: 0.08,
    minUserBudgetUsdc: 0.0007,
  },
  premium: {
    publicLabel: "Advanced",
    maxSources: 8,
    maxPaidAgentCalls: 8,
    creatorPayoutCapUsdc: 0.0001,
    actualSpendCapUsdc: 0.00015,
    minEvidenceScore: 0.80,
    stopMarginalValueBelow: 0.06,
    minUserBudgetUsdc: 0.001,
  },
} as const;

// ─── Budget Rules ───────────────────────────────────────────────
// user budget = maximum approved cap
// effective spend cap = min(user budget, route actualSpendCapUsdc)
// unused budget stays unused
// split applies to actual spend only

export const SPLIT_RULE_VERSION = "v1_85_10_5" as const;
export const SPLIT_CREATOR_PCT = 0.85;
export const SPLIT_AGENT_PCT = 0.10;
export const SPLIT_TREASURY_PCT = 0.05;

export function computeEffectiveSpendCap(
  userBudgetUsdc: number,
  routeTier: RouteTier
): number {
  const limits = ROUTE_LIMITS[routeTier];
  return Math.min(userBudgetUsdc, limits.actualSpendCapUsdc);
}

export function computeSplit(amountUsdc: number): {
  creator_amount_usdc: number;
  agent_fee_usdc: number;
  treasury_fee_usdc: number;
} {
  return {
    creator_amount_usdc: Math.round(amountUsdc * SPLIT_CREATOR_PCT * 1e8) / 1e8,
    agent_fee_usdc: Math.round(amountUsdc * SPLIT_AGENT_PCT * 1e8) / 1e8,
    treasury_fee_usdc: Math.round(amountUsdc * SPLIT_TREASURY_PCT * 1e8) / 1e8,
  };
}

// Backward compat alias
export type { RouteConfig as RouteTierConfig };

export function getRouteConfig(tier: string): RouteConfig {
  if (tier in ROUTE_CONFIG) {
    return ROUTE_CONFIG[tier as RouteTier];
  }
  return ROUTE_CONFIG.normal;
}

export function getRouteLimits(tier: string): RouteLimits {
  if (tier in ROUTE_LIMITS) {
    return ROUTE_LIMITS[tier as RouteTier];
  }
  return ROUTE_LIMITS.normal;
}

// ─── Minimum Budget Gate ──────────────────────────────────────

/** Get the minimum user budget for a given internal route tier. */
export function getMinimumUserBudgetUsdc(tier: RouteTier): number {
  return ROUTE_LIMITS[tier].minUserBudgetUsdc;
}

/** Validate that user budget meets the minimum for the route tier. */
export function validateRouteBudget(
  userBudgetUsdc: number,
  routeTier: RouteTier
): { ok: true } | { ok: false; minRequired: number; publicLabel: string } {
  const limits = ROUTE_LIMITS[routeTier];
  if (userBudgetUsdc >= limits.minUserBudgetUsdc) {
    return { ok: true };
  }
  return {
    ok: false,
    minRequired: limits.minUserBudgetUsdc,
    publicLabel: limits.publicLabel,
  };
}

export function isValidRouteTier(tier: string): tier is RouteTier {
  return tier === "normal" || tier === "advanced" || tier === "premium";
}

/** Get public label for a route tier */
export function getPublicLabel(tier: string): string {
  return getRouteConfig(tier).publicLabel;
}
