/**
 * Service Handler Helpers
 */

import type { DelegatedRouteTier } from "@/lib/paylabs/delegated-runtime/types";
import { toInternalTier, type InternalRouteTier } from "@/lib/paylabs/route-tier";

/**
 * Convert delegated runtime tier to internal RouteTier.
 * Delegated: easy | normal | advanced
 * Internal: normal | advanced | premium
 */
export function toInternalRouteTier(tier: DelegatedRouteTier): InternalRouteTier {
  return toInternalTier(tier);
}
