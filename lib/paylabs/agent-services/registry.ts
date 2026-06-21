/**
 * Agent Service Registry
 *
 * Static registry of 9 delegated service agents.
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
    allowedBuyers: ["run_budget_controller"],
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
    allowedBuyers: ["intent_planner"],
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
    allowedBuyers: ["query_builder"],
    outputSchemaName: "SignalScoutOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_SIGNAL_SCOUT_BUYER_WALLET_ID",
  },
  {
    serviceName: "intent_matcher",
    macroNode: "payment_decision",
    reusedAgents: ["source_ranker"],
    requiresLlm: true,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/intent_matcher/run",
    allowedBuyers: ["signal_scout"],
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
    allowedBuyers: ["intent_matcher"],
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
    allowedBuyers: ["source_verifier"],
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
    allowedBuyers: ["value_allocator"],
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
    priceUsdc: 0,
    endpointPath: "/api/paylabs/agent-services/payment_decider/run",
    allowedBuyers: ["trust_verifier"],
    outputSchemaName: "PaymentDeciderOutput",
    isActive: true,
  },
  {
    serviceName: "payment_router",
    macroNode: "settlement_memory",
    reusedAgents: ["payment_quote", "payment_executor"],
    requiresLlm: false,
    priceUsdc: 0.000001,
    endpointPath: "/api/paylabs/agent-services/payment_router/run",
    allowedBuyers: ["payment_decider"],
    outputSchemaName: "PaymentRouterOutput",
    isActive: true,
    sellerWalletAddressEnv: "PAYLABS_SERVICE_PAYMENT_ROUTER_SELLER_WALLET_ADDRESS",
    buyerWalletIdEnv: "PAYLABS_SERVICE_PAYMENT_ROUTER_BUYER_WALLET_ID",
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
