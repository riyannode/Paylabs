// GET /api/paylabs/payments/readiness
//
// Safe readiness check for PayLabs payment infrastructure.
// Returns configuration status WITHOUT exposing env values or secrets.
// Missing keys are reported by name only.

import { NextResponse } from "next/server";
import { isDelegatedRuntimeEnabled, getX402EnabledServices } from "@/lib/paylabs/feature-flags";
import { getRegisteredServiceCount, getActiveServiceCount, getActiveServices } from "@/lib/paylabs/agent-services/registry";
import { getAllowedEdgeCount } from "@/lib/paylabs/agent-services/edge-allowlist";

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

  const ready =
    missingKeys.length === 0 &&
    isDelegatedRuntimeEnabled() &&
    activeServices.length > 0;

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
  });
}
