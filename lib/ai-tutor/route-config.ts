/**
 * Route Tier Configuration
 * Defines behavior parameters for each route tier.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 *
 * Internal values (normal/advanced/premium) unchanged for DB compatibility.
 * Public labels: Easy / Normal / Advanced.
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

// Backward compat alias
export type { RouteConfig as RouteTierConfig };

export function getRouteConfig(tier: string): RouteConfig {
  if (tier in ROUTE_CONFIG) {
    return ROUTE_CONFIG[tier as RouteTier];
  }
  return ROUTE_CONFIG.normal;
}

export function isValidRouteTier(tier: string): tier is RouteTier {
  return tier === "normal" || tier === "advanced" || tier === "premium";
}

/** Get public label for a route tier */
export function getPublicLabel(tier: string): string {
  return getRouteConfig(tier).publicLabel;
}
