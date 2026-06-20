/**
 * Payments Routes — Readiness + x402 Settlement
 *
 * GET  /api/paylabs/payments/readiness — Check all prerequisites
 * POST /api/paylabs/payments/discovery — Process discovery fee payment
 * POST /api/paylabs/payments/agent-nanopayment — Process single agent nanopayment
 * GET  /api/paylabs/payments/gateway-balance — Query Gateway unified balance
 *
 * PR #16: Wire real Circle Gateway x402 settlement for agent nanopayments.
 */

import { Hono } from "hono";
import { supabaseAdmin } from "../proxy/supabase.js";
import {
  resolveTreasuryWallet,
  resolveReserveWallet,
  getMissingAgentWallets,
  PAID_AGENTS,
  resolveAgentWallet,
  AGENT_NANOPRICE_USDC,
} from "../proxy/agent-registry.js";
import { verifyX402Authorization, type SignedAuthorization } from "../proxy/x402.js";
import { checkDcwApiReachable } from "../services/circleDcw.js";
import {
  checkX402Config,
  checkGatewayReachable,
  settleX402Payment,
  queryGatewayBalance,
} from "../services/circleX402Settle.js";

export const paymentsRoutes = new Hono();

// ─── Inlined Discovery Fee Tiers ─────────────────────────────
// Must match DISCOVERY_FEE_TIERS in lib/paylabs/route-tier.ts exactly.

type ExternalRouteTier = "easy" | "normal" | "advanced";

const FEE_TIERS: Record<
  ExternalRouteTier,
  { totalFeeUsdc: string; agentNanopaymentsUsdc: string; gatewayBufferUsdc: string; treasuryFeeUsdc: string }
> = {
  easy: {
    totalFeeUsdc: "0.001000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000050",
    treasuryFeeUsdc: "0.000943",
  },
  normal: {
    totalFeeUsdc: "0.002000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000100",
    treasuryFeeUsdc: "0.001893",
  },
  advanced: {
    totalFeeUsdc: "0.003000",
    agentNanopaymentsUsdc: "0.000007",
    gatewayBufferUsdc: "0.000150",
    treasuryFeeUsdc: "0.002843",
  },
};

function getFeeTier(tier: string) {
  return FEE_TIERS[(tier as ExternalRouteTier) in FEE_TIERS ? (tier as ExternalRouteTier) : "easy"];
}

// ─── GET /readiness ──────────────────────────────────────────

paymentsRoutes.get("/readiness", async (c) => {
  const missing: string[] = [];
  const unsupported: string[] = [];
  const checks: Record<string, string> = {};

  // 1. Payment route
  const route = process.env.PAYLABS_PAYMENT_ROUTE || "none";
  checks.paymentRoute = route;
  if (route === "none") missing.push("PAYLABS_PAYMENT_ROUTE");

  // 2. Payment executor
  const executor = process.env.PAYLABS_PAYMENT_EXECUTOR || "noop";
  checks.paymentExecutor = executor;
  if (executor === "noop") missing.push("PAYLABS_PAYMENT_EXECUTOR");

  // 3. HMAC secret
  if (!process.env.PAYLABS_HMAC_SECRET) missing.push("PAYLABS_HMAC_SECRET");

  // 4. Circle API key
  if (!process.env.CIRCLE_API_KEY) missing.push("CIRCLE_API_KEY");

  // 5. Entity secret
  if (!process.env.CIRCLE_ENTITY_SECRET) missing.push("CIRCLE_ENTITY_SECRET");

  // 6. Treasury wallet
  const treasury = resolveTreasuryWallet();
  if (!treasury.walletId) missing.push("PAYLABS_TREASURY_WALLET_ID");
  if (!treasury.address) missing.push("PAYLABS_TREASURY_WALLET_ADDRESS");

  // 7. Reserve wallet
  const reserve = resolveReserveWallet();
  if (!reserve.walletId) missing.push("PAYLABS_RESERVE_WALLET_ID");
  if (!reserve.address) missing.push("PAYLABS_RESERVE_WALLET_ADDRESS");

  // 8. Agent wallets (7 agents)
  const missingAgents = getMissingAgentWallets();
  if (missingAgents.length > 0) {
    for (const agent of missingAgents) {
      const def = PAID_AGENTS.find((a: { name: string }) => a.name === agent);
      if (def) missing.push(def.envWalletAddressKey);
    }
  }

  // 9. Gateway/x402 config
  const x402Config = checkX402Config();
  if (!x402Config.configured) {
    missing.push(...x402Config.missing);
  }

  // 10. DCW API reachable (only if credentials present)
  let dcwReachable = false;
  if (process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET) {
    const dcwCheck = await checkDcwApiReachable();
    dcwReachable = dcwCheck.reachable;
    if (!dcwCheck.reachable) {
      unsupported.push(`Circle DCW API unreachable: ${dcwCheck.error || "unknown"}`);
    }
  }

  // 11. Gateway reachable + Arc Testnet domain supported
  let gatewayReachable = false;
  let arcDomainSupported = false;
  const gwCheck = await checkGatewayReachable();
  gatewayReachable = gwCheck.reachable;
  if (!gwCheck.reachable) {
    unsupported.push(`Circle Gateway unreachable: ${gwCheck.error || "unknown"}`);
  } else if (gwCheck.supportedDomains) {
    arcDomainSupported = gwCheck.supportedDomains.includes(26);
    if (!arcDomainSupported) {
      unsupported.push("Arc Testnet (domain 26) not in Gateway supported domains");
    }
  }

  // 12. Flags summary
  const discoveryFeeEnabled = process.env.PAYLABS_X402_DISCOVERY_FEE_ENABLED === "true";
  const agentNanoEnabled = process.env.PAYLABS_AGENT_NANOPAYMENTS_ENABLED === "true";
  checks.discoveryFeeEnabled = String(discoveryFeeEnabled);
  checks.agentNanopaymentsEnabled = String(agentNanoEnabled);

  const ready = missing.length === 0 && unsupported.length === 0;

  return c.json({
    ready,
    status: ready ? "ready" : "setup_required",
    missing,
    unsupported,
    checks: {
      ...checks,
      dcwReachable,
      gatewayReachable,
      arcDomainSupported,
      treasuryWalletId: treasury.walletId ? "set" : "missing",
      reserveWalletId: reserve.walletId ? "set" : "missing",
      agentWalletsConfigured: 7 - missingAgents.length,
      agentWalletsMissing: missingAgents,
    },
  });
});

// ─── POST /discovery ─────────────────────────────────────────

paymentsRoutes.post("/discovery", async (c) => {
  const discoveryFeeEnabled = process.env.PAYLABS_X402_DISCOVERY_FEE_ENABLED === "true";

  if (!discoveryFeeEnabled) {
    return c.json(
      {
        ok: false,
        status: "disabled",
        message: "Discovery fee payments are disabled. Set PAYLABS_X402_DISCOVERY_FEE_ENABLED=true.",
      },
      400
    );
  }

  let body: {
    discoveryRunId?: string;
    userWallet?: string;
    routeTier?: string;
    signedAuthorization?: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
      signature: string;
    };
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.discoveryRunId || !body.userWallet || !body.routeTier) {
    return c.json(
      { ok: false, error: "discoveryRunId, userWallet, and routeTier are required" },
      400
    );
  }

  if (!body.signedAuthorization) {
    return c.json(
      { ok: false, status: "payment_required", error: "signedAuthorization required when discovery fee is enabled" },
      402
    );
  }

  // Treasury wallet
  const treasury = resolveTreasuryWallet();
  if (!treasury.address) {
    return c.json({ ok: false, status: "setup_required", error: "Treasury wallet not configured" }, 503);
  }

  // Fee tier
  const feeTier = getFeeTier(body.routeTier!);
  const amountUsdc = parseFloat(feeTier.totalFeeUsdc);

  // Nonce check via DB
  const nonceExists = async (nonceHash: string): Promise<boolean> => {
    const { data } = await supabaseAdmin()
      .from("paylabs_discovery_payments")
      .select("id")
      .eq("nonce_hash", nonceHash)
      .limit(1);
    return !!(data && data.length > 0);
  };

  // Verify x402 authorization
  const auth = body.signedAuthorization!;
  const verifyResult = await verifyX402Authorization(
    {
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce as `0x${string}`,
      signature: auth.signature as `0x${string}`,
    },
    amountUsdc,
    treasury.address as `0x${string}`,
    nonceExists
  );

  if (!verifyResult.valid) {
    return c.json(
      { ok: false, status: "failed", error: `x402 verification failed: ${verifyResult.error}` },
      402
    );
  }

  // Submit to Gateway for settlement
  const settleResult = await settleX402Payment({
    signedAuthorization: auth as unknown as SignedAuthorization,
    amountBaseUnits: BigInt(Math.round(amountUsdc * 1_000_000)).toString(),
    receiverAddress: treasury.address,
  });

  if (!settleResult.ok) {
    // Store failed payment record
    await supabaseAdmin()
      .from("paylabs_discovery_payments")
      .insert({
        discovery_run_id: body.discoveryRunId,
        user_wallet: body.userWallet!.toLowerCase(),
        route_tier: body.routeTier,
        amount_usdc: amountUsdc,
        agent_nanopayment_total_usdc: parseFloat(feeTier.agentNanopaymentsUsdc),
        gateway_buffer_usdc: parseFloat(feeTier.gatewayBufferUsdc),
        treasury_fee_usdc: parseFloat(feeTier.treasuryFeeUsdc),
        nonce_hash: verifyResult.paymentId,
        status: "failed",
        failure_reason: settleResult.error,
      });

    return c.json(
      { ok: false, status: "failed", error: settleResult.error, infraFailure: settleResult.infraFailure },
      settleResult.infraFailure ? 503 : 402
    );
  }

  // Store successful payment with REAL refs from Gateway
  const { data: paymentRow, error: insertError } = await supabaseAdmin()
    .from("paylabs_discovery_payments")
    .insert({
      discovery_run_id: body.discoveryRunId,
      user_wallet: body.userWallet!.toLowerCase(),
      route_tier: body.routeTier,
      amount_usdc: amountUsdc,
      agent_nanopayment_total_usdc: parseFloat(feeTier.agentNanopaymentsUsdc),
      gateway_buffer_usdc: parseFloat(feeTier.gatewayBufferUsdc),
      treasury_fee_usdc: parseFloat(feeTier.treasuryFeeUsdc),
      x402_payment_ref: settleResult.paymentRef || null,
      x402_settlement_ref: settleResult.settlementRef || null,
      gateway_response: settleResult.gatewayResponse || null,
      nonce_hash: verifyResult.paymentId,
      status: "paid",
    })
    .select("id")
    .single();

  if (insertError) {
    return c.json({ ok: false, error: `Payment settled but failed to record: ${insertError.message}` }, 500);
  }

  return c.json({
    ok: true,
    status: "paid",
    paymentId: paymentRow?.id,
    paymentRef: settleResult.paymentRef,
    settlementRef: settleResult.settlementRef,
  });
});

// ─── POST /agent-nanopayment ─────────────────────────────────

paymentsRoutes.post("/agent-nanopayment", async (c) => {
  const agentNanoEnabled = process.env.PAYLABS_AGENT_NANOPAYMENTS_ENABLED === "true";

  if (!agentNanoEnabled) {
    return c.json({ ok: false, status: "disabled", message: "Agent nanopayments are disabled." }, 400);
  }

  let body: {
    discoveryRunId?: string;
    agentName?: string;
    signedAuthorization?: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
      signature: string;
    };
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.discoveryRunId || !body.agentName) {
    return c.json({ ok: false, error: "discoveryRunId and agentName are required" }, 400);
  }

  if (!body.signedAuthorization) {
    return c.json({ ok: false, status: "payment_required", error: "signedAuthorization required" }, 402);
  }

  // Validate agent wallet
  const agentWallet = resolveAgentWallet(body.agentName);
  if (!agentWallet) {
    return c.json(
      { ok: false, status: "setup_required", error: `Wallet not configured for agent: ${body.agentName}` },
      503
    );
  }

  // Nonce check
  const nonceExists = async (nonceHash: string): Promise<boolean> => {
    const { data } = await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .select("id")
      .eq("x402_payment_ref", nonceHash)
      .limit(1);
    return !!(data && data.length > 0);
  };

  // Verify x402
  const auth = body.signedAuthorization!;
  const verifyResult = await verifyX402Authorization(
    {
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce as `0x${string}`,
      signature: auth.signature as `0x${string}`,
    },
    parseFloat(AGENT_NANOPRICE_USDC),
    agentWallet as `0x${string}`,
    nonceExists
  );

  if (!verifyResult.valid) {
    return c.json(
      { ok: false, status: "failed", error: `Verification failed: ${verifyResult.error}` },
      402
    );
  }

  // Submit to Gateway
  const settleResult = await settleX402Payment({
    signedAuthorization: body.signedAuthorization as unknown as SignedAuthorization,
    amountBaseUnits: "1", // 0.000001 USDC = 1 base unit
    receiverAddress: agentWallet,
  });

  if (!settleResult.ok) {
    return c.json(
      { ok: false, status: "failed", error: settleResult.error, infraFailure: settleResult.infraFailure },
      settleResult.infraFailure ? 503 : 402
    );
  }

  // Update nanopayment row with real refs
  const { data: nanoRow } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .select("receipt_id")
    .eq("discovery_run_id", body.discoveryRunId)
    .eq("agent_name", body.agentName)
    .limit(1)
    .single();

  if (nanoRow) {
    await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .update({
        status: "paid",
        x402_payment_ref: settleResult.paymentRef || null,
        x402_settlement_ref: settleResult.settlementRef || null,
      })
      .eq("receipt_id", nanoRow.receipt_id);
  }

  return c.json({
    ok: true,
    status: "paid",
    agentName: body.agentName,
    paymentRef: settleResult.paymentRef,
    settlementRef: settleResult.settlementRef,
    receiptId: nanoRow?.receipt_id,
  });
});

// ─── GET /gateway-balance ────────────────────────────────────

paymentsRoutes.get("/gateway-balance", async (c) => {
  const walletAddress = c.req.query("wallet");
  if (!walletAddress) {
    return c.json({ ok: false, error: "wallet query param required" }, 400);
  }

  const result = await queryGatewayBalance(walletAddress);
  return c.json(result);
});
