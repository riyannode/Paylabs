/**
 * Route Tier Configuration
 * Defines behavior parameters for each route tier.
 * Route tier changes planning behavior and prompt persona only.
 * Route tier NEVER weakens safety checks.
 */

export type RouteTier = "normal" | "advanced" | "premium";

export interface RouteConfig {
  tier: RouteTier;
  label: string;
  maxLessons: number;
  reasoningDepth: "low" | "medium" | "high";
  sourceStrictness: "standard" | "high" | "very_high";
  plannerStyle: "quick_intro" | "builder_path" | "deep_mastery";
  description: string;
}

export const ROUTE_CONFIG: Record<RouteTier, RouteConfig> = {
  normal: {
    tier: "normal",
    label: "Normal Route",
    maxLessons: 2,
    reasoningDepth: "low",
    sourceStrictness: "standard",
    plannerStyle: "quick_intro",
    description: "Quick, cheap, beginner-friendly path.",
  },
  advanced: {
    tier: "advanced",
    label: "Advanced Route",
    maxLessons: 5,
    reasoningDepth: "medium",
    sourceStrictness: "high",
    plannerStyle: "builder_path",
    description: "Technical builder path for implementation-focused users.",
  },
  premium: {
    tier: "premium",
    label: "Premium Route",
    maxLessons: 8,
    reasoningDepth: "high",
    sourceStrictness: "very_high",
    plannerStyle: "deep_mastery",
    description: "Deepest source-backed path for full mastery.",
  },
} as const;

export function getRouteConfig(tier: string): RouteConfig {
  if (tier in ROUTE_CONFIG) {
    return ROUTE_CONFIG[tier as RouteTier];
  }
  return ROUTE_CONFIG.normal;
}

export function isValidRouteTier(tier: string): tier is RouteTier {
  return tier === "normal" || tier === "advanced" || tier === "premium";
}
