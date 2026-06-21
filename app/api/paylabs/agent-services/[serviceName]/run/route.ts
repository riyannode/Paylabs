/**
 * Dynamic Service Endpoint
 *
 * POST /api/paylabs/agent-services/[serviceName]/run
 *
 * Behavior:
 * - validate serviceName exists (400 if invalid)
 * - require buyerAgentName (400 if missing — fail closed)
 * - validate buyer→seller edge allowlist (403 if not allowed — fail closed)
 * - validate request body with per-service Zod schema (400 if invalid)
 * - ALL service endpoints are audit-only in this PR
 * - x402 service challenge/verify/settle is NOT implemented
 * - call handler directly, mark settled=false, mode=audit_only
 * - return structured output only
 * - never return raw chain-of-thought
 * - never return raw x-payment header/signature
 * - never return raw Gateway/DCW internals
 * - never create fake payment refs
 */

import { NextRequest, NextResponse } from "next/server";
import { isValidServiceName, getServiceConfig } from "@/lib/paylabs/agent-services/registry";
import { assertAllowedAgentServiceEdge } from "@/lib/paylabs/agent-services/edge-allowlist";
import { SERVICE_HANDLERS } from "@/lib/paylabs/agent-services/handlers";
import { getInputSchema } from "@/lib/paylabs/agent-services/schemas";
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
      },
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

  // ── Call handler — audit-only mode ──
  // x402 service challenge/verify/settle is NOT implemented in this PR.
  // All service endpoints are audit-only. settled=false always.
  const handler = SERVICE_HANDLERS[serviceNameTyped];
  if (!handler) {
    return NextResponse.json(
      { ok: false, error: `No handler for service: ${serviceName}` },
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

    // Always audit-only: settled=false, no x402 challenge
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
      { ok: false, serviceName, error: `Handler error: ${msg}` },
      { status: 500 }
    );
  }
}
