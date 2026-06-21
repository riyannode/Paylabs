/**
 * Service Handler Helpers
 */

import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import type { RouteTier } from "@/lib/ai/route-config";

/**
 * Convert delegated runtime tier to internal RouteTier.
 * Delegated: easy | normal | advanced
 * Internal: normal | advanced | premium
 */
export function toInternalRouteTier(tier: DelegatedRouteTier): RouteTier {
  const map: Record<DelegatedRouteTier, RouteTier> = {
    easy: "normal",
    normal: "advanced",
    advanced: "premium",
  };
  return map[tier] || "normal";
}
