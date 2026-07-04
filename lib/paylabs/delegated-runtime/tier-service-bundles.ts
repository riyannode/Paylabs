/**
 * Tier Service Bundles — Macro-Node Specific Service Presets
 *
 * Each macro-node has its own tier-dependent service bundle.
 * This replaces the flat TIER_SERVICE_PRESETS for macro-node routing.
 *
 * Rules:
 * - Easy: signal_scout_basics ONLY (never signal_scout)
 * - Normal: signal_scout ONLY (never signal_scout_basics)
 * - Advanced: signal_scout ONLY (never signal_scout_basics)
 * - Never execute both signal_scout and signal_scout_basics in same run
 */

import type { ServiceName } from "../agent-services/types";
import type { DelegatedRouteTier } from "./types";

// ─── Discovery Planner Service Presets ────────────────────────

export const DISCOVERY_PLANNER_SERVICE_PRESETS: Record<
  DelegatedRouteTier,
  ServiceName[]
> = {
  easy: ["intent_planner", "query_builder", "signal_scout_basics"],
  normal: ["intent_planner", "query_builder", "signal_scout"],
  advanced: ["intent_planner", "query_builder", "signal_scout"],
};

// ─── Payment Decision Service Presets ─────────────────────────

export const PAYMENT_DECISION_SERVICE_PRESETS: Record<
  DelegatedRouteTier,
  ServiceName[]
> = {
  easy: [],
  normal: [
    "intent_matcher",
    "source_verifier",
    "value_allocator",
    "trust_verifier",
    "payment_decider",
  ],
  advanced: [
    "intent_matcher",
    "source_verifier",
    "value_allocator",
    "trust_verifier",
    "payment_decider",
  ],
};

// ─── Settlement Memory Service Presets ────────────────────────

export const SETTLEMENT_MEMORY_SERVICE_PRESETS: Record<
  DelegatedRouteTier,
  ServiceName[]
> = {
  easy: [],
  normal: ["creator_attribution", "creator_payout_router"],
  advanced: [
    "creator_attribution",
    "advanced_evidence_evaluator",
    "creator_payout_router",
  ],
};

// ─── Lookup Helper ────────────────────────────────────────────

/**
 * Get the service bundle for a specific macro-node + tier combination.
 * Used by the macro-node route to determine which child services to execute.
 */
export function getMacroNodeServicesForTier(
  nodeName: string,
  routeTier: DelegatedRouteTier
): ServiceName[] {
  if (nodeName === "discovery_planner")
    return DISCOVERY_PLANNER_SERVICE_PRESETS[routeTier];
  if (nodeName === "payment_decision")
    return PAYMENT_DECISION_SERVICE_PRESETS[routeTier];
  if (nodeName === "settlement_memory")
    return SETTLEMENT_MEMORY_SERVICE_PRESETS[routeTier];
  return [];
}

// ─── Scout Bundle Guard ───────────────────────────────────────

/**
 * Fail-closed guard: ensures the correct scout variant is selected for the tier.
 *
 * Rules:
 * - Easy → must include signal_scout_basics, must NOT include signal_scout
 * - Normal/Advanced → must include signal_scout, must NOT include signal_scout_basics
 * - Never both variants in the same run
 * - Never neither variant
 */
export function assertValidDiscoveryScoutBundle(
  routeTier: DelegatedRouteTier,
  selectedServices: ServiceName[],
): void {
  const hasBasic = selectedServices.includes("signal_scout_basics");
  const hasFull = selectedServices.includes("signal_scout");

  if (hasBasic && hasFull) {
    throw new Error(
      `invalid_discovery_scout_bundle: both signal_scout and signal_scout_basics selected (tier=${routeTier})`
    );
  }

  if (!hasBasic && !hasFull) {
    throw new Error(
      `invalid_discovery_scout_bundle: no scout service selected (tier=${routeTier})`
    );
  }

  if (routeTier === "easy" && !hasBasic) {
    throw new Error(
      `invalid_discovery_scout_bundle: easy tier requires signal_scout_basics, got signal_scout`
    );
  }

  if ((routeTier === "normal" || routeTier === "advanced") && !hasFull) {
    throw new Error(
      `invalid_discovery_scout_bundle: ${routeTier} tier requires signal_scout, got signal_scout_basics`
    );
  }
}
