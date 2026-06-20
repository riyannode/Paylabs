// GET /api/paylabs/payments/readiness
//
// Safe readiness check for PayLabs payment infrastructure.
// Returns configuration status WITHOUT exposing env values or secrets.
// Missing keys are reported by name only.

import { NextResponse } from "next/server";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import {
  PAID_AGENTS,
  resolveAgentWallet,
  resolveTreasuryWallet,
} from "@/lib/paylabs/agent-registry";

export async function GET() {
  const flags = getPaymentFlags();
  const treasury = resolveTreasuryWallet();

  // Check which agent wallets are configured (by name only)
  const configuredWallets: string[] = [];
  const missingWallets: string[] = [];

  for (const agent of PAID_AGENTS) {
    const wallet = resolveAgentWallet(agent.name);
    if (wallet) {
      configuredWallets.push(agent.name);
    } else {
      missingWallets.push(agent.name);
    }
  }

  // Check required env keys (name only, never values)
  const requiredKeys = [
    "PAYLABS_HMAC_SECRET",
    "CIRCLE_API_KEY",
    "CIRCLE_ENTITY_SECRET",
  ];

  const missingKeys: string[] = [];
  for (const key of requiredKeys) {
    if (!process.env[key]) {
      missingKeys.push(key);
    }
  }

  const treasuryConfigured = !!treasury.address;
  const gatewayEnabled =
    flags.paymentRoute === "circle_gateway_x402" &&
    flags.paymentExecutor === "circle_sdk";

  const ready =
    missingKeys.length === 0 &&
    treasuryConfigured &&
    configuredWallets.length === PAID_AGENTS.length;

  return NextResponse.json({
    ready,
    status: ready ? "operational" : "degraded",
    missing_keys: missingKeys,
    payment_route: flags.paymentRoute,
    payment_executor: flags.paymentExecutor,
    treasury_configured: treasuryConfigured,
    gateway_enabled: gatewayEnabled,
    agent_wallets: {
      configured_count: configuredWallets.length,
      total_count: PAID_AGENTS.length,
      missing: missingWallets,
    },
    flags: {
      discovery_fee: flags.discoveryFeeEnabled,
      agent_nanopayments: flags.agentNanopaymentsEnabled,
      batch_settlement: flags.agentBatchSettlementEnabled,
    },
  });
}
