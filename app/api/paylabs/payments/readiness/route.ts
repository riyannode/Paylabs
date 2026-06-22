// GET /api/paylabs/payments/readiness
//
// Safe readiness check for PayLabs payment infrastructure.
// Returns configuration status WITHOUT exposing env values or secrets.
// Missing keys are reported by name only.

import { NextResponse } from "next/server";
import { isDelegatedRuntimeEnabled, getX402EnabledServices } from "@/lib/paylabs/feature-flags";
import { getRegisteredServiceCount, getActiveServiceCount, getActiveServices } from "@/lib/paylabs/agent-services/registry";
import { getAllowedEdgeCount } from "@/lib/paylabs/agent-services/edge-allowlist";

const REQUIRED_X402_SERVICES = [
  "intent_planner",
  "query_builder",
  "signal_scout",
  "intent_matcher",
  "source_verifier",
  "value_allocator",
  "trust_verifier",
  "payment_decider",
  "payment_router",
];

const REQUIRED_WALLET_ENV_KEYS = [
  "PAYLABS_CONTROLLER_BUYER_WALLET_ID",
  "PAYLABS_BRAIN_BUYER_WALLET_ID",
  "PAYLABS_BRAIN_SELLER_WALLET_ADDRESS",

  "PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID",
  "PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS",

  "PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID",
  "PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS",

  "PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID",
  "PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS",

  "PAYLABS_SERVICE_INTENT_PLANNER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_QUERY_BUILDER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_SIGNAL_SCOUT_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_INTENT_MATCHER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_SOURCE_VERIFIER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_VALUE_ALLOCATOR_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_TRUST_VERIFIER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_PAYMENT_DECIDER_SELLER_WALLET_ADDRESS",
  "PAYLABS_SERVICE_PAYMENT_ROUTER_SELLER_WALLET_ADDRESS",
];

export async function GET() {
  // Check required env keys (name only, never values)
  const requiredKeys = [
    "PAYLABS_HMAC_SECRET",
    "CIRCLE_API_KEY",
    "CIRCLE_ENTITY_SECRET",
    "PAYLABS_DELEGATED_RUNTIME_ENABLED",
    "PAYLABS_DELEGATED_INLINE_EXECUTION",
    "PAYLABS_BRAIN_X402_ENABLED",
    "PAYLABS_NODE_X402_ENABLED",
    "PAYLABS_AGENT_NANOPAYMENTS_ENABLED",
  ];

  const missingKeys: string[] = [];
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      missingKeys.push(key);
    }
  }

  const activeServices = getActiveServices();
  const x402EnabledServices = getX402EnabledServices();

  const missingX402Services = REQUIRED_X402_SERVICES.filter(
    (svc) => !x402EnabledServices.includes(svc)
  );

  const missingWalletEnvKeys = REQUIRED_WALLET_ENV_KEYS.filter(
    (key) => !process.env[key]
  );

  const ready =
    missingKeys.length === 0 &&
    missingWalletEnvKeys.length === 0 &&
    isDelegatedRuntimeEnabled() &&
    process.env.PAYLABS_DELEGATED_INLINE_EXECUTION === "true" &&
    process.env.PAYLABS_BRAIN_X402_ENABLED === "true" &&
    process.env.PAYLABS_NODE_X402_ENABLED === "true" &&
    process.env.PAYLABS_AGENT_NANOPAYMENTS_ENABLED === "true" &&
    missingX402Services.length === 0;

  return NextResponse.json({
    ready,
    status: ready ? "operational" : "degraded",
    missing_keys: missingKeys,
    delegated_runtime: {
      enabled: isDelegatedRuntimeEnabled(),
      registered_service_count: getRegisteredServiceCount(),
      active_service_count: getActiveServiceCount(),
      active_services: activeServices.map((s) => s.serviceName),
      allowlisted_edge_count: getAllowedEdgeCount(),
      x402_enabled_services: x402EnabledServices,
    },
    x402_services: {
      required: REQUIRED_X402_SERVICES,
      enabled: x402EnabledServices,
      missing: missingX402Services,
      all_enabled: missingX402Services.length === 0,
    },
    wallet_env: {
      required_count: REQUIRED_WALLET_ENV_KEYS.length,
      missing: missingWalletEnvKeys,
    },
  });
}
