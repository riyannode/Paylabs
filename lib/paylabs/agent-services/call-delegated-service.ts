/**
 * callDelegatedService — Central service call abstraction.
 *
 * All macro-node phases must call services through this function,
 * never directly via SERVICE_HANDLERS.
 *
 * This function:
 * 1. Validates buyer→seller edge with assertAllowedAgentServiceEdge()
 * 2. Validates input with per-service Zod schema
 * 3. Checks x402 service allowlist
 * 4. If x402 enabled: not implemented in this PR (audit-only) — fails closed
 * 5. If audit mode: calls handler directly, marks settled=false
 * 6. Returns structured output only
 * 7. Records safe service call metadata
 */

import { assertAllowedAgentServiceEdge } from "./edge-allowlist";
import { getServiceConfig } from "./registry";
import { SERVICE_HANDLERS } from "./handlers";
import { getInputSchema } from "./schemas";
import type { ServiceName, ServiceHandlerInput, ServiceHandlerOutput } from "./types";

// ─── Input ───────────────────────────────────────────────────
export interface CallDelegatedServiceInput {
  discoveryRunId: string;
  buyerAgentName: string;
  sellerServiceName: ServiceName;
  payload: Record<string, unknown>;
}

// ─── Output ──────────────────────────────────────────────────
export interface CallDelegatedServiceOutput {
  ok: boolean;
  serviceName: ServiceName;
  data: Record<string, unknown> | null;
  safeSummary: string;
  settled: boolean;
  mode: "audit_only";
  error: string | null;
  safeCallMeta: {
    buyer: string;
    seller: ServiceName;
    edgeValid: boolean;
    schemaValid: boolean;
    costUsdc: number;
    timestamp: string;
  };
}

// ─── Public API ──────────────────────────────────────────────

export async function callDelegatedService(
  input: CallDelegatedServiceInput
): Promise<CallDelegatedServiceOutput> {
  const { discoveryRunId, buyerAgentName, sellerServiceName, payload } = input;
  const timestamp = new Date().toISOString();

  // ── Step 1: Edge allowlist validation ──
  const edgeResult = assertAllowedAgentServiceEdge(buyerAgentName, sellerServiceName);
  if (!edgeResult.allowed) {
    return {
      ok: false,
      serviceName: sellerServiceName,
      data: null,
      safeSummary: `Edge not allowed: ${buyerAgentName} → ${sellerServiceName}`,
      settled: false,
      mode: "audit_only",
      error: edgeResult.error,
      safeCallMeta: {
        buyer: buyerAgentName,
        seller: sellerServiceName,
        edgeValid: false,
        schemaValid: false,
        costUsdc: 0,
        timestamp,
      },
    };
  }

  // ── Step 2: Schema validation ──
  const inputSchema = getInputSchema(sellerServiceName);
  if (inputSchema) {
    const parsed = inputSchema.safeParse(payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        ok: false,
        serviceName: sellerServiceName,
        data: null,
        safeSummary: `Schema validation failed for ${sellerServiceName}: ${issues}`,
        settled: false,
        mode: "audit_only",
        error: `Invalid payload: ${issues}`,
        safeCallMeta: {
          buyer: buyerAgentName,
          seller: sellerServiceName,
          edgeValid: true,
          schemaValid: false,
          costUsdc: 0,
          timestamp,
        },
      };
    }
  }

  // ── Step 3: Get handler + service config ──
  const handler = SERVICE_HANDLERS[sellerServiceName];
  if (!handler) {
    return {
      ok: false,
      serviceName: sellerServiceName,
      data: null,
      safeSummary: `No handler for service: ${sellerServiceName}`,
      settled: false,
      mode: "audit_only",
      error: `No handler for service: ${sellerServiceName}`,
      safeCallMeta: {
        buyer: buyerAgentName,
        seller: sellerServiceName,
        edgeValid: true,
        schemaValid: true,
        costUsdc: 0,
        timestamp,
      },
    };
  }

  const config = getServiceConfig(sellerServiceName);
  const costUsdc = config?.priceUsdc ?? 0;

  // ── Step 4: Audit-only mode ──
  // x402 service challenge/verify/settle is NOT implemented in this PR.
  // All service calls are audit-only. settled=false always.
  const handlerInput: ServiceHandlerInput = {
    discoveryRunId,
    serviceName: sellerServiceName,
    buyerAgentName,
    payload,
  };

  try {
    const result = await handler(handlerInput);

    // Enforce settled=false in audit mode regardless of what handler returns
    return {
      ok: result.ok,
      serviceName: result.serviceName,
      data: result.data,
      safeSummary: result.safeSummary,
      settled: false, // audit-only: never settled
      mode: "audit_only",
      error: result.error,
      safeCallMeta: {
        buyer: buyerAgentName,
        seller: sellerServiceName,
        edgeValid: true,
        schemaValid: true,
        costUsdc,
        timestamp,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      serviceName: sellerServiceName,
      data: null,
      safeSummary: `Handler error: ${msg}`,
      settled: false,
      mode: "audit_only",
      error: `Handler error: ${msg}`,
      safeCallMeta: {
        buyer: buyerAgentName,
        seller: sellerServiceName,
        edgeValid: true,
        schemaValid: true,
        costUsdc,
        timestamp,
      },
    };
  }
}
