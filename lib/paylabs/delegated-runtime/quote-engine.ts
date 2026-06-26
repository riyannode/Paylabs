/**
 * Canonical Quote Engine
 *
 * Single source of truth for deterministic pricing and budget validation.
 * Brain chooses logic. Quote engine chooses cost.
 *
 * Creator Distribution V1:
 * - Easy: discovery only, no creator payout
 * - Normal: +payment decision +settlement memory, 1 creator payout
 * - Advanced: +payment decision +settlement memory +deep agent, 2 creator payouts
 */

import type { MacroNodePhase, ServiceName } from "@/lib/paylabs/delegated-runtime/types";

// ─── Types ───────────────────────────────────────────────────

export type DelegatedRouteTier = "easy" | "normal" | "advanced";
export type BudgetStatus = "ok" | "over_budget";

export type QuoteInput = {
  routeTier: DelegatedRouteTier;
  userBudgetUsdc: number;
  maxRegistryChecks?: number;
  maxSourceAccesses?: number;
};

export type DelegatedRunQuote = {
  routeTier: DelegatedRouteTier;
  selectedMacroNodes: MacroNodePhase[];
  selectedServices: ServiceName[];
  servicesByMacroNode: Record<MacroNodePhase, ServiceName[]>;
  expectedPaymentEdges: number;
  macroNodeFeesUsdc: number;
  serviceEdgeFeesUsdc: number;
  registryCheckFeesUsdc: number;
  sourceAccessFeesUsdc: number;
  executionFeeUsdc: number;
  plannedCreatorPoolUsdc: number;
  totalPlannedCostUsdc: number;
  creatorPayoutLimit: number;
  plannedCreatorPoolAtomic: bigint;
  expectedCreatorPayoutCount: number;
  plannedBotShareUsdc: number;
  plannedServiceShareUsdc: number;
  pricingVersion: "creator_split_v1";
  // Legacy fields (backward compat)
  plannedCostUsdc: number;
  userBudgetUsdc: number;
  remainingPlannedBudgetUsdc: number;
  budgetStatus: BudgetStatus;
  locked: true;
};

// ─── Fixed Fee Constants (single source of truth) ────────────

export const FIXED_FEES_USDC = {
  brainTreasury: 0.000003,
  macroNode: 0.000001,
  serviceEdge: 0.000001,
  registryCheck: 0.000001,
  sourceAccess: 0.000001,
} as const;

// ─── Creator Payout Constants ─────────────────────────────────

export const CREATOR_PAYOUT_UNIT_USDC = 0.000020;
export const CREATOR_PAYOUT_UNIT_ATOMIC = BigInt(20);

export const CREATOR_PAYOUT_LIMIT: Record<DelegatedRouteTier, number> = {
  easy: 0,
  normal: 1,
  advanced: 2,
};

// ─── Tier → Phase Mapping ────────────────────────────────────
// Normal now includes settlement_memory for creator payout

export const TIER_PHASE_MAP: Record<DelegatedRouteTier, MacroNodePhase[]> = {
  easy: ["discovery_planner"],
  normal: ["discovery_planner", "payment_decision", "settlement_memory"],
  advanced: ["discovery_planner", "payment_decision", "settlement_memory"],
};

// ─── Tier → Service Presets (canonical bundles) ──────────────
// Includes creator distribution services for Normal/Advanced

export const TIER_SERVICE_PRESETS: Record<DelegatedRouteTier, ServiceName[]> = {
  easy: ["intent_planner", "query_builder", "signal_scout_basics"],
  normal: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
    "creator_attribution", "creator_payout_router",
  ],
  advanced: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
    "creator_attribution", "advanced_evidence_evaluator", "creator_payout_router",
  ],
};

// ─── Service → Macro-Node Mapping ────────────────────────────

export const SERVICE_MACRO_MAP: Record<ServiceName, MacroNodePhase> = {
  intent_planner: "discovery_planner",
  query_builder: "discovery_planner",
  signal_scout: "discovery_planner",
  signal_scout_basics: "discovery_planner",
  intent_matcher: "payment_decision",
  source_verifier: "payment_decision",
  value_allocator: "payment_decision",
  trust_verifier: "payment_decision",
  payment_decider: "payment_decision",
  payment_router: "settlement_memory",
  creator_attribution: "settlement_memory",
  advanced_evidence_evaluator: "settlement_memory",
  creator_payout_router: "settlement_memory",
};

// ─── Edge Count ──────────────────────────────────────────────

/**
 * Expected payment edge count for a given tier.
 *
 * Breakdown:
 *   controller → brain = 1
 *   brain → each macro-node = macroNodes.length
 *   each macro-node → child services = services.length
 *
 * easy:     1 + 1 + 3 = 5
 * normal:   1 + 3 + 10 = 14
 * advanced: 1 + 3 + 11 = 15
 */
export function getExpectedPaymentEdgeCount(tier: DelegatedRouteTier): number {
  const macroNodes = TIER_PHASE_MAP[tier];
  const services = TIER_SERVICE_PRESETS[tier];
  return 1 + macroNodes.length + services.length;
}

// ─── Quote ───────────────────────────────────────────────────

/**
 * Compute a deterministic quote for a delegated runtime run.
 * No LLM, no wallet, no network — pure math from tier + budget + limits.
 */
export function quoteDelegatedRun(input: QuoteInput): DelegatedRunQuote {
  const routeTier = input.routeTier;
  const maxRegistryChecks = Math.max(0, input.maxRegistryChecks ?? 0);
  const maxSourceAccesses = Math.max(0, input.maxSourceAccesses ?? 0);

  const selectedMacroNodes = TIER_PHASE_MAP[routeTier];
  const selectedServices = TIER_SERVICE_PRESETS[routeTier];

  const servicesByMacroNode: Record<MacroNodePhase, ServiceName[]> = {
    discovery_planner: [],
    payment_decision: [],
    settlement_memory: [],
  };
  for (const service of selectedServices) {
    const macroNode = SERVICE_MACRO_MAP[service];
    servicesByMacroNode[macroNode].push(service);
  }

  const macroNodeFeesUsdc = selectedMacroNodes.length * FIXED_FEES_USDC.macroNode;
  const serviceEdgeFeesUsdc = selectedServices.length * FIXED_FEES_USDC.serviceEdge;
  const registryCheckFeesUsdc = maxRegistryChecks * FIXED_FEES_USDC.registryCheck;
  const sourceAccessFeesUsdc = maxSourceAccesses * FIXED_FEES_USDC.sourceAccess;

  // Execution fee = brain + macro nodes + service edges + registry + source
  const executionFeeUsdc =
    FIXED_FEES_USDC.brainTreasury +
    macroNodeFeesUsdc +
    serviceEdgeFeesUsdc +
    registryCheckFeesUsdc +
    sourceAccessFeesUsdc;

  // Creator pool
  const creatorLimit = CREATOR_PAYOUT_LIMIT[routeTier];
  const plannedCreatorPoolAtomic = BigInt(creatorLimit) * CREATOR_PAYOUT_UNIT_ATOMIC;
  const plannedCreatorPoolUsdc = creatorLimit * CREATOR_PAYOUT_UNIT_USDC;

  // Bot/service share (per creator slot: bot=2, service=1 atomic)
  const plannedBotShareUsdc = creatorLimit * (2 / 1e6);
  const plannedServiceShareUsdc = creatorLimit * (1 / 1e6);

  // Total = execution fee + creator pool
  const totalPlannedCostUsdc = executionFeeUsdc + plannedCreatorPoolUsdc;

  const remainingPlannedBudgetUsdc = input.userBudgetUsdc - totalPlannedCostUsdc;

  return {
    routeTier,
    selectedMacroNodes,
    selectedServices,
    servicesByMacroNode,
    expectedPaymentEdges: getExpectedPaymentEdgeCount(routeTier),
    macroNodeFeesUsdc,
    serviceEdgeFeesUsdc,
    registryCheckFeesUsdc,
    sourceAccessFeesUsdc,
    executionFeeUsdc,
    plannedCreatorPoolUsdc,
    totalPlannedCostUsdc,
    creatorPayoutLimit: creatorLimit,
    plannedCreatorPoolAtomic,
    expectedCreatorPayoutCount: creatorLimit,
    plannedBotShareUsdc,
    plannedServiceShareUsdc,
    pricingVersion: "creator_split_v1",
    // Legacy compat
    plannedCostUsdc: totalPlannedCostUsdc,
    userBudgetUsdc: input.userBudgetUsdc,
    remainingPlannedBudgetUsdc,
    budgetStatus: remainingPlannedBudgetUsdc >= 0 ? "ok" : "over_budget",
    locked: true,
  };
}

// ─── Budget Guardrail ────────────────────────────────────────

/**
 * Fail closed if planned cost exceeds user budget.
 * Throws before any x402 payment is attempted.
 */
export function assertBudgetOrThrow(quote: DelegatedRunQuote): void {
  if (quote.budgetStatus === "over_budget") {
    throw new Error(
      `budget_exceeded: planned cost ${quote.totalPlannedCostUsdc.toFixed(6)} USDC exceeds user budget ${quote.userBudgetUsdc.toFixed(6)} USDC`
    );
  }
}
