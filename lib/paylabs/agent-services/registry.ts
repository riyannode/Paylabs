/**
 * Agent Service Registry
 *
 * Static registry of 12 delegated service agents.
 * Each service maps to a macro-node phase and reuses existing agents.
 *
 * This is the NEW delegated service registry — separate from the existing
 * agent-registry.ts (which defines the 7 paid capability agents).
 * Both coexist. The existing registry is NOT deleted.
 */

import type { ServiceConfig, ServiceName, ServiceMacroNode } from "./types";

// ─── Service Definitions ─────────────────────────────────────
const SERVICES: ReadonlyArray<ServiceConfig> = [
  {
    serviceName: "intent_planner",
    macroNode: "discovery_planner",
    reusedAgents: ["tutor_intake", "intent_classifier"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/intent_planner/run",
    allowedBuyers: ["discovery_planner"],
    outputSchemaName: "IntentPlannerOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_INTENT_PLANNER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_INTENT_PLANNER_BUYER_WALLET_ID",
  },
  {
    serviceName: "query_builder",
    macroNode: "discovery_planner",
    reusedAgents: ["query_expander"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/query_builder/run",
    allowedBuyers: ["discovery_planner"],
    outputSchemaName: "QueryBuilderOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_QUERY_BUILDER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_QUERY_BUILDER_BUYER_WALLET_ID",
  },
  {
    serviceName: "signal_scout",
    macroNode: "discovery_planner",
    reusedAgents: ["source_ranker"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/signal_scout/run",
    allowedBuyers: ["discovery_planner"],
    outputSchemaName: "SignalScoutOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_BUYER_WALLET_ID",
  },
  {
    serviceName: "signal_scout_basics",
    macroNode: "discovery_planner",
    reusedAgents: [],
    requiresLlm: false,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/signal_scout_basics/run",
    allowedBuyers: ["discovery_planner"],
    outputSchemaName: "SignalScoutBasicsOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_BASICS_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_BASICS_BUYER_WALLET_ID",
  },
  {
    serviceName: "intent_matcher",
    macroNode: "payment_decision",
    reusedAgents: ["source_ranker"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/intent_matcher/run",
    allowedBuyers: ["payment_decision"],
    outputSchemaName: "IntentMatcherOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_INTENT_MATCHER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_INTENT_MATCHER_BUYER_WALLET_ID",
  },
  {
    serviceName: "source_verifier",
    macroNode: "payment_decision",
    reusedAgents: ["source_quality_verifier"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/source_verifier/run",
    allowedBuyers: ["payment_decision"],
    outputSchemaName: "SourceVerifierOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_SOURCE_VERIFIER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_SOURCE_VERIFIER_BUYER_WALLET_ID",
  },
  {
    serviceName: "value_allocator",
    macroNode: "payment_decision",
    reusedAgents: ["budget_optimizer", "payment_quote"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/value_allocator/run",
    allowedBuyers: ["payment_decision"],
    outputSchemaName: "ValueAllocatorOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_VALUE_ALLOCATOR_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_VALUE_ALLOCATOR_BUYER_WALLET_ID",
  },
  {
    serviceName: "trust_verifier",
    macroNode: "payment_decision",
    reusedAgents: ["provenance_verifier", "creator_ownership_verifier"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/trust_verifier/run",
    allowedBuyers: ["payment_decision"],
    outputSchemaName: "TrustVerifierOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_TRUST_VERIFIER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_TRUST_VERIFIER_BUYER_WALLET_ID",
  },
  {
    serviceName: "payment_decider",
    macroNode: "payment_decision",
    reusedAgents: [],
    requiresLlm: false,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/payment_decider/run",
    allowedBuyers: ["payment_decision"],
    outputSchemaName: "PaymentDeciderOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_PAYMENT_DECIDER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_PAYMENT_DECIDER_BUYER_WALLET_ID",
  },

  {
    serviceName: "creator_attribution",
    macroNode: "settlement_memory",
    reusedAgents: [],
    requiresLlm: false,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/creator_attribution/run",
    allowedBuyers: ["settlement_memory"],
    outputSchemaName: "CreatorAttributionOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_CREATOR_ATTRIBUTION_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_CREATOR_ATTRIBUTION_BUYER_WALLET_ID",
  },
  {
    serviceName: "advanced_evidence_evaluator",
    macroNode: "settlement_memory",
    reusedAgents: ["deep_evidence_evaluator"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/advanced_evidence_evaluator/run",
    allowedBuyers: ["settlement_memory"],
    outputSchemaName: "AdvancedEvidenceEvaluatorOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_ADVANCED_EVIDENCE_EVALUATOR_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_ADVANCED_EVIDENCE_EVALUATOR_BUYER_WALLET_ID",
  },
  {
    serviceName: "creator_payout_router",
    macroNode: "settlement_memory",
    reusedAgents: ["payment_executor"],
    requiresLlm: false,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/creator_payout_router/run",
    allowedBuyers: ["settlement_memory"],
    outputSchemaName: "CreatorPayoutRouterOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_CREATOR_PAYOUT_ROUTER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_CREATOR_PAYOUT_ROUTER_BUYER_WALLET_ID",
  },
] as const;

// ─── Lookup Maps ─────────────────────────────────────────────
const SERVICE_MAP = new Map<ServiceName, ServiceConfig>(
  SERVICES.map((s) => [s.serviceName, s])
);

const MACRO_NODE_SERVICES = new Map<ServiceMacroNode, ServiceConfig[]>();
for (const svc of SERVICES) {
  const list = MACRO_NODE_SERVICES.get(svc.macroNode) || [];
  list.push(svc);
  MACRO_NODE_SERVICES.set(svc.macroNode, list);
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get service config by name.
 */
export function getServiceConfig(name: ServiceName): ServiceConfig | undefined {
  return SERVICE_MAP.get(name);
}

/**
 * Get all registered services.
 */
export function getAllServices(): ReadonlyArray<ServiceConfig> {
  return SERVICES;
}

/**
 * Get services for a specific macro-node phase.
 */
export function getServicesForMacroNode(
  phase: ServiceMacroNode
): ServiceConfig[] {
  return MACRO_NODE_SERVICES.get(phase) || [];
}

/**
 * Get active services only.
 */
export function getActiveServices(): ServiceConfig[] {
  return SERVICES.filter((s) => s.isActive);
}

/**
 * Get count of registered services.
 */
export function getRegisteredServiceCount(): number {
  return SERVICES.length;
}

/**
 * Get count of active services.
 */
export function getActiveServiceCount(): number {
  return SERVICES.filter((s) => s.isActive).length;
}

/**
 * Check if a service name is valid.
 */
export function isValidServiceName(name: string): name is ServiceName {
  return SERVICE_MAP.has(name as ServiceName);
}
