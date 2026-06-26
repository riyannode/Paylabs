/**
 * Canonical Quote Engine
 *
 * Single source of truth for deterministic pricing and budget validation.
 * Brain chooses logic. Quote engine chooses cost.
 *
 * Brain may decide: route tier, macro-node plan, service plan, query strategy,
 *   max registry checks, max source accesses, safe summary.
 * Brain must NOT decide: prices, final cost, wallets, payment endpoint,
 *   settlement mode, payment refs, tx hashes, budget bypass.
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

// ─── Tier → Phase Mapping ────────────────────────────────────

export const TIER_PHASE_MAP: Record<DelegatedRouteTier, MacroNodePhase[]> = {
  easy: ["discovery_planner"],
  normal: ["discovery_planner", "payment_decision"],
  advanced: ["discovery_planner", "payment_decision", "settlement_memory"],
};

// ─── Tier → Service Presets (canonical bundles) ──────────────

export const TIER_SERVICE_PRESETS: Record<DelegatedRouteTier, ServiceName[]> = {
  easy: ["intent_planner", "query_builder", "signal_scout_basics"],
  normal: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
  ],
  advanced: [
    "intent_planner", "query_builder", "signal_scout",
    "intent_matcher", "source_verifier", "value_allocator",
    "trust_verifier", "payment_decider",
    "payment_router",
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
 * normal:   1 + 2 + 8 = 11
 * advanced: 1 + 3 + 9 = 13
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

  const plannedCostUsdc =
    FIXED_FEES_USDC.brainTreasury +
    macroNodeFeesUsdc +
    serviceEdgeFeesUsdc +
    registryCheckFeesUsdc +
    sourceAccessFeesUsdc;

  const remainingPlannedBudgetUsdc = input.userBudgetUsdc - plannedCostUsdc;

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
    plannedCostUsdc,
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
      `budget_exceeded: planned cost ${quote.plannedCostUsdc.toFixed(6)} USDC exceeds user budget ${quote.userBudgetUsdc.toFixed(6)} USDC`
    );
  }
}
