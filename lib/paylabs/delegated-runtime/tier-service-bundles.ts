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

// ─── Scout Variant Helper ─────────────────────────────────────

export interface DiscoveryScoutVariant {
  serviceName: ServiceName;
  debugLabel: string;
  tierScope: string;
}

/**
 * Get the signal scout variant for a given tier.
 * Easy → signal_scout_basics, Normal/Advanced → signal_scout
 */
export function getDiscoveryScoutVariant(
  routeTier: DelegatedRouteTier
): DiscoveryScoutVariant {
  if (routeTier === "easy") {
    return {
      serviceName: "signal_scout_basics",
      debugLabel: "basic_rsshub_only",
      tierScope: "easy_only",
    };
  }

  return {
    serviceName: "signal_scout",
    debugLabel:
      routeTier === "normal" ? "normal_signal_scout" : "advanced_signal_scout",
    tierScope: routeTier,
  };
}

// ─── Scout Bundle Guard ───────────────────────────────────────

/**
 * Fail-closed guard: ensures exactly one scout variant is selected.
 * Never both signal_scout AND signal_scout_basics.
 * Never neither.
 */
export function assertValidDiscoveryScoutBundle(
  selectedServices: ServiceName[]
): void {
  const hasBasic = selectedServices.includes("signal_scout_basics");
  const hasFull = selectedServices.includes("signal_scout");

  if (hasBasic && hasFull) {
    throw new Error(
      "invalid_discovery_scout_bundle: both signal_scout and signal_scout_basics selected"
    );
  }

  if (!hasBasic && !hasFull) {
    throw new Error(
      "invalid_discovery_scout_bundle: no scout service selected"
    );
  }
}
