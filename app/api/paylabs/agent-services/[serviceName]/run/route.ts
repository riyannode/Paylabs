/**
 * Dynamic Service Endpoint
 *
 * POST /api/paylabs/agent-services/[serviceName]/run
 *
 * Behavior:
 * - validate serviceName exists
 * - validate request body with schema
 * - validate buyer/seller edge allowlist if buyerAgentName is provided
 * - if service is x402-enabled through PAYLABS_X402_ENABLED_SERVICE_NAMES,
 *   use PR #19 x402 challenge/verify/settle logic
 * - otherwise run in audit/internal mode and clearly mark settled=false
 * - call mapped handler
 * - return structured output only
 * - never return raw chain-of-thought
 * - never return raw x-payment header/signature
 * - never return raw Gateway/DCW internals
 * - never create fake payment refs
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidServiceName } from "@/lib/paylabs/agent-services/registry";
import { getServiceConfig } from "@/lib/paylabs/agent-services/registry";
import { assertAllowedAgentServiceEdge } from "@/lib/paylabs/agent-services/edge-allowlist";
import { SERVICE_HANDLERS } from "@/lib/paylabs/agent-services/handlers";
import { isX402EnabledForService } from "@/lib/paylabs/feature-flags";
import type { ServiceHandlerInput, ServiceName } from "@/lib/paylabs/agent-services/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> }
) {
  const { serviceName } = await params;

  // ── Validate service name ──
  if (!isValidServiceName(serviceName)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Invalid service name: ${serviceName}`,
        valid_services: Object.keys(SERVICE_HANDLERS),
      },
      { status: 400 }
    );
  }

  const serviceNameTyped = serviceName as ServiceName;
  const config = getServiceConfig(serviceNameTyped);

  // ── Validate service is active ──
  if (!config || !config.isActive) {
    return NextResponse.json(
      {
        ok: false,
        error: `Service ${serviceName} is not active`,
      },
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

  // ── Validate edge allowlist ──
  if (buyerAgentName) {
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
  }

  // ── Check x402 mode ──
  const isX402 = isX402EnabledForService(serviceNameTyped);

  // ── Build handler input ──
  const handlerInput: ServiceHandlerInput = {
    discoveryRunId,
    serviceName: serviceNameTyped,
    buyerAgentName: buyerAgentName || undefined,
    payload,
  };

  // ── Call handler ──
  const handler = SERVICE_HANDLERS[serviceNameTyped];
  if (!handler) {
    return NextResponse.json(
      { ok: false, error: `No handler for service: ${serviceName}` },
      { status: 500 }
    );
  }

  try {
    const result = await handler(handlerInput);

    // ── If x402 enabled, return 402 challenge ──
    // In x402 mode, the service would return a 402 PAYMENT-REQUIRED response
    // that the buyer must sign and retry. For now, mark the x402 status.
    if (isX402 && !result.settled) {
      return NextResponse.json(
        {
          ...result,
          x402_required: true,
          x402_service: serviceName,
          message: `Service ${serviceName} requires x402 payment. Include PAYMENT-SIGNATURE header.`,
        },
        { status: 402 }
      );
    }

    // ── Return structured output only ──
    // Strip any accidental raw chain-of-thought or secrets
    return NextResponse.json({
      ok: result.ok,
      serviceName: result.serviceName,
      data: result.data,
      safeSummary: result.safeSummary,
      settled: result.settled,
      error: result.error,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        serviceName,
        error: `Handler error: ${msg}`,
      },
      { status: 500 }
    );
  }
}
