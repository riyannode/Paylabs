/**
 * Dynamic Service Endpoint
 *
 * POST /api/paylabs/agent-services/[serviceName]/run
 *
 * DUAL MODE:
 * - If service is NOT in PAYLABS_X402_ENABLED_SERVICE_NAMES:
 *   audit-only. settled=false, mode="audit_only". Handler runs directly.
 *
 * - If service IS in PAYLABS_X402_ENABLED_SERVICE_NAMES:
 *   First request (no payment header): returns real HTTP 402 + PAYMENT-REQUIRED header.
 *   Retry with payment header: verify/settle via Circle x402-batching SDK.
 *   Handler runs ONLY after settlement succeeds.
 *   Safe payment metadata stored in response.
 *
 * Security:
 * - Never return raw x-payment header/signature
 * - Never return raw Gateway/DCW internals
 * - Never return raw chain-of-thought
 * - Never create fake payment refs
 * - Fail closed on all payment errors
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidServiceName, getServiceConfig } from "@/lib/paylabs/agent-services/registry";
import { assertAllowedAgentServiceEdge } from "@/lib/paylabs/agent-services/edge-allowlist";
import { SERVICE_HANDLERS } from "@/lib/paylabs/agent-services/handlers";
import { getInputSchema } from "@/lib/paylabs/agent-services/schemas";
import type { ServiceHandlerInput, ServiceName } from "@/lib/paylabs/agent-services/types";
import { isX402EnabledForService } from "@/lib/paylabs/feature-flags";
import {
  buildX402Challenge,
  encodeChallengeHeader,
  verifyAndSettlePayment,
  type X402ChallengeRequirements,
} from "@/lib/paylabs/x402/seller-challenge";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> }
) {
  const { serviceName } = await params;

  // ── Validate service name ──
  if (!isValidServiceName(serviceName)) {
    return NextResponse.json(
      { ok: false, error: `Invalid service name: ${serviceName}` },
      { status: 400 }
    );
  }

  const serviceNameTyped = serviceName as ServiceName;
  const config = getServiceConfig(serviceNameTyped);

  // ── Validate service is active ──
  if (!config || !config.isActive) {
    return NextResponse.json(
      { ok: false, error: `Service ${serviceName} is not active` },
      { status: 400 }
    );
  }

  // ── Parse request body ──
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { buyerAgentName, discoveryRunId, payload } = body as {
    buyerAgentName?: string;
    discoveryRunId?: string;
    payload?: Record<string, unknown>;
  };

  // ── Require buyerAgentName — fail closed ──
  if (!buyerAgentName || typeof buyerAgentName !== "string") {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid buyerAgentName (required)" },
      { status: 400 }
    );
  }

  // ── Validate edge allowlist — fail closed ──
  const edgeResult = assertAllowedAgentServiceEdge(buyerAgentName, serviceNameTyped);
  if (!edgeResult.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: edgeResult.error,
        edge: `${buyerAgentName} → ${serviceName}`,
      },
      { status: 403 }
    );
  }

  // ── Validate required fields ──
  if (!payload || typeof payload !== "object") {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid payload" },
      { status: 400 }
    );
  }

  if (!discoveryRunId || typeof discoveryRunId !== "string") {
    return NextResponse.json(
      { ok: false, error: "Missing discoveryRunId" },
      { status: 400 }
    );
  }

  // ── Validate payload with per-service Zod schema ──
  const inputSchema = getInputSchema(serviceNameTyped);
  if (inputSchema) {
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i: { path: (string | number)[]; message: string }) =>
          `${i.path.join(".")}: ${i.message}`
      );
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid payload",
          validation_errors: issues,
        },
        { status: 400 }
      );
    }
  }

  // ── Check x402 enablement ──
  const x402Enabled = isX402EnabledForService(serviceNameTyped);

  if (!x402Enabled) {
    // ── Audit-only path: handler runs directly ──
    return executeAuditOnly(serviceNameTyped, buyerAgentName, discoveryRunId, payload);
  }

  // ── x402 path: challenge → verify → settle → handler ──
  return executeX402SellerPath(req, serviceNameTyped, config, buyerAgentName, discoveryRunId, payload);
}

// ─── Audit-Only Path ─────────────────────────────────────────

async function executeAuditOnly(
  serviceNameTyped: ServiceName,
  buyerAgentName: string,
  discoveryRunId: string,
  payload: Record<string, unknown>
) {
  const handler = SERVICE_HANDLERS[serviceNameTyped];
  if (!handler) {
    return NextResponse.json(
      { ok: false, error: `No handler for service: ${serviceNameTyped}` },
      { status: 500 }
    );
  }

  const handlerInput: ServiceHandlerInput = {
    discoveryRunId,
    serviceName: serviceNameTyped,
    buyerAgentName,
    payload,
  };

  try {
    const result = await handler(handlerInput);

    return NextResponse.json({
      ok: result.ok,
      serviceName: result.serviceName,
      data: result.data,
      safeSummary: result.safeSummary,
      settled: false,
      mode: "audit_only",
      error: result.error,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, serviceName: serviceNameTyped, error: `Handler error: ${msg}` },
      { status: 500 }
    );
  }
}

// ─── x402 Seller Path ────────────────────────────────────────

/**
 * Handle x402-enabled service edge:
 * 1. Check for payment header
 * 2. If missing: return 402 + PAYMENT-REQUIRED challenge
 * 3. If present: verify + settle via BatchFacilitatorClient
 * 4. Execute handler only after settlement
 * 5. Return result with safe payment metadata
 */
async function executeX402SellerPath(
  req: NextRequest,
  serviceNameTyped: ServiceName,
  config: NonNullable<ReturnType<typeof getServiceConfig>>,
  buyerAgentName: string,
  discoveryRunId: string,
  payload: Record<string, unknown>
) {
  // ── Resolve seller wallet address ──
  const walletEnvName = config.sellerWalletAddressEnv;
  if (!walletEnvName) {
    return NextResponse.json(
      { ok: false, error: "Service x402 config error: sellerWalletAddressEnv not set" },
      { status: 500 }
    );
  }

  const sellerAddress = (process.env[walletEnvName] || "").trim();
  if (!sellerAddress || !/^0x[a-fA-F0-9]{40}$/.test(sellerAddress)) {
    return NextResponse.json(
      { ok: false, error: "Service x402 config error: invalid seller wallet address" },
      { status: 500 }
    );
  }

  // ── Check for payment header ──
  const paymentHeader =
    req.headers.get("payment-signature") ??
    req.headers.get("PAYMENT-SIGNATURE") ??
    req.headers.get("x-payment") ??
    req.headers.get("X-Payment");

  if (!paymentHeader) {
    // ── No payment: return 402 challenge ──
    const amountAtomic = computeAmountAtomic(config.priceUsdc);
    const challenge = buildX402Challenge(sellerAddress, amountAtomic, req.url);
    const encoded = encodeChallengeHeader(challenge);

    const response = NextResponse.json(
      {
        ok: false,
        error: "Payment required",
        x402: true,
        service: serviceNameTyped,
        amount_usdc: config.priceUsdc.toString(),
      },
      { status: 402 }
    );
    response.headers.set("PAYMENT-REQUIRED", encoded);
    return response;
  }

  // ── Payment header present: verify + settle ──
  const amountAtomic = computeAmountAtomic(config.priceUsdc);
  const requirements = buildRequirements(sellerAddress, amountAtomic);

  const settleResult = await verifyAndSettlePayment(paymentHeader, requirements);

  if (!settleResult.ok || !settleResult.settled) {
    return NextResponse.json(
      {
        ok: false,
        error: settleResult.error || "Payment verification/settlement failed",
        settled: false,
      },
      { status: 402 }
    );
  }

  // ── Payment settled: execute handler ──
  const handler = SERVICE_HANDLERS[serviceNameTyped];
  if (!handler) {
    return NextResponse.json(
      { ok: false, error: `No handler for service: ${serviceNameTyped}` },
      { status: 500 }
    );
  }

  const handlerInput: ServiceHandlerInput = {
    discoveryRunId,
    serviceName: serviceNameTyped,
    buyerAgentName,
    payload,
  };

  try {
    const result = await handler(handlerInput);

    return NextResponse.json({
      ok: result.ok,
      serviceName: result.serviceName,
      data: result.data,
      safeSummary: result.safeSummary,
      settled: true,
      mode: "x402",
      error: result.error,
      paymentMeta: settleResult.paymentMeta,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        serviceName: serviceNameTyped,
        error: `Handler error after settlement: ${msg}`,
        settled: true,
        mode: "x402",
        paymentMeta: settleResult.paymentMeta,
      },
      { status: 500 }
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Compute amount in atomic units (6 decimals for USDC).
 * e.g. 0.000001 USDC = 1 atomic unit.
 */
function computeAmountAtomic(priceUsdc: number): string {
  if (priceUsdc <= 0) return "1"; // minimum 1 atomic unit
  return Math.round(priceUsdc * 1_000_000).toString();
}

/**
 * Build x402 payment requirements for the seller challenge.
 */
function buildRequirements(sellerAddress: string, amountAtomic: string): X402ChallengeRequirements {
  return {
    scheme: "exact",
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: amountAtomic,
    payTo: sellerAddress.toLowerCase(),
    maxTimeoutSeconds: 604800,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };
}
