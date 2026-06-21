/**
 * callDelegatedService — Central service call abstraction.
 *
 * All macro-node phases must call services through this function,
 * never directly via SERVICE_HANDLERS.
 *
 * DUAL PATH:
 *   x402-enabled services: HTTP call to seller endpoint via buyer-transport
 *   audit-only services: direct in-process handler call
 *
 * This function:
 * 1. Validates buyer→seller edge with assertAllowedAgentServiceEdge()
 * 2. Validates input with per-service Zod schema
 * 3. Checks x402 service allowlist (isX402EnabledForService)
 * 4. If x402 enabled:
 *    - Requires absolute seller URL, DCW signer, buyer wallet ID
 *    - Verifies Gateway balance before signing
 *    - Calls seller endpoint through buyer-transport (requirePayment=true)
 *    - Fails closed on non-402/free response
 *    - Fails closed on missing safe payment metadata
 *    - Stores safe payment metadata in output
 * 5. If audit-only:
 *    - Calls handler directly (in-process)
 *    - settled=false always
 * 6. Returns structured output + safe call metadata
 */

import { assertAllowedAgentServiceEdge } from "./edge-allowlist";
import { getServiceConfig } from "./registry";
import { SERVICE_HANDLERS } from "./handlers";
import { getInputSchema } from "./schemas";
import { isX402EnabledForService } from "../feature-flags";
import { getDcwSigner } from "../paid-agent-node";
import { callPaidSeller } from "../x402/buyer-transport";
import { verifySufficientBalance } from "../x402/gateway-balance";
import type { ServiceName, ServiceHandlerInput, ServiceHandlerOutput } from "./types";

// ─── Input ───────────────────────────────────────────────────
export interface CallDelegatedServiceInput {
  discoveryRunId: string;
  buyerAgentName: string;
  sellerServiceName: ServiceName;
  payload: Record<string, unknown>;
  /** Override buyer wallet ID for payment graph (macro-node → child). */
  buyerWalletIdOverride?: string;
}

// ─── Output ──────────────────────────────────────────────────
export interface CallDelegatedServiceOutput {
  ok: boolean;
  serviceName: ServiceName;
  data: Record<string, unknown> | null;
  safeSummary: string;
  settled: boolean;
  mode: "audit_only" | "x402";
  error: string | null;
  safeCallMeta: {
    buyer: string;
    seller: ServiceName;
    edgeValid: boolean;
    schemaValid: boolean;
    costUsdc: number;
    timestamp: string;
  };
  /** Safe payment metadata (only present when settled=true via x402) */
  paymentMeta?: {
    amountAtomic: string;
    payTo: string;
    network: string;
    x402Version: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Resolve the absolute seller URL for a service endpoint.
 * Fails closed if no base URL is configured (never silently builds relative URL).
 */
function resolveSellerUrl(serviceEndpointPath: string): string {
  // Prefer VERCEL_URL (auto-set by Vercel to current deployment hostname)
  // to avoid chicken-and-egg: PAYLABS_APP_URL may point to old deployment
  const vercelUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : undefined;
  const baseUrl =
    vercelUrl ||
    process.env.PAYLABS_APP_URL ||
    process.env.NEXT_PUBLIC_PAYLABS_APP_URL ||
    "";
  if (!baseUrl) {
    throw new Error(
      "config_error: PAYLABS_APP_URL or NEXT_PUBLIC_PAYLABS_APP_URL must be set for x402-enabled services"
    );
  }
  // Normalize: strip trailing slash from base, ensure leading slash on path
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = serviceEndpointPath.startsWith("/")
    ? serviceEndpointPath
    : `/${serviceEndpointPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Resolve the seller wallet address from the service config env var.
 * Fails closed if env var is missing or empty.
 */
function resolveSellerWallet(config: { sellerWalletAddressEnv?: string }): string {
  const envName = config.sellerWalletAddressEnv;
  if (!envName) {
    throw new Error("config_error: sellerWalletAddressEnv not configured for this service");
  }
  const address = (process.env[envName] || "").trim();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error(
      `config_error: ${envName} must be a valid EVM address (got: "${address || "empty"}")`
    );
  }
  return address.toLowerCase();
}

/**
 * Resolve the buyer DCW wallet ID from the service config env var.
 * Fails closed if env var is missing or empty.
 */
function resolveBuyerWalletId(config: { buyerWalletIdEnv?: string }): string {
  const envName = config.buyerWalletIdEnv;
  if (!envName) {
    throw new Error("config_error: buyerWalletIdEnv not configured for this service");
  }
  const walletId = (process.env[envName] || "").trim();
  if (!walletId) {
    throw new Error(`config_error: ${envName} must be set for x402-enabled services`);
  }
  return walletId;
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
    console.log(`[callDelegatedService] ${sellerServiceName}: EDGE NOT ALLOWED: ${buyerAgentName} → ${sellerServiceName}`);
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
      console.log(`[callDelegatedService] ${sellerServiceName}: SCHEMA FAILED: ${issues}`);
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

  // ── Step 4: Check x402 enablement ──
  const x402Enabled = isX402EnabledForService(sellerServiceName);


  if (x402Enabled) {
    // ── x402 path: real payment via HTTP buyer-transport ──
    return executeX402Path({
      discoveryRunId,
      buyerAgentName,
      sellerServiceName,
      payload,
      handler,
      config: config!,
      costUsdc,
      timestamp,
      buyerWalletIdOverride: input.buyerWalletIdOverride,
    });
  }

  // ── Step 5: Audit-only path: direct in-process handler call ──
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

// ─── x402 Path ───────────────────────────────────────────────

/**
 * Execute the x402 payment path for a service edge.
 *
 * Flow:
 * 1. Resolve seller URL (fail closed if missing)
 * 2. Resolve seller wallet address (fail closed if missing)
 * 3. Resolve buyer wallet ID (fail closed if missing)
 * 4. Get DCW signer (fail closed if not injected)
 * 5. Get buyer wallet address from DCW signer
 * 6. Verify Gateway balance (fail closed if insufficient)
 * 7. Call seller endpoint via buyer-transport (requirePayment=true)
 * 8. Fail closed if seller doesn't return 402 (requirePayment=true)
 * 9. Fail closed if payment metadata is missing
 * 10. Return handler result with safe payment metadata
 */
async function executeX402Path(params: {
  discoveryRunId: string;
  buyerAgentName: string;
  sellerServiceName: ServiceName;
  payload: Record<string, unknown>;
  handler: (input: ServiceHandlerInput) => Promise<ServiceHandlerOutput>;
  config: { endpointPath: string; sellerWalletAddressEnv?: string; buyerWalletIdEnv?: string; priceUsdc: number };
  costUsdc: number;
  timestamp: string;
  buyerWalletIdOverride?: string;
}): Promise<CallDelegatedServiceOutput> {
  const {
    discoveryRunId,
    buyerAgentName,
    sellerServiceName,
    payload,
    config,
    costUsdc,
    timestamp,
  } = params;

  // ── Resolve seller URL ──
  let sellerUrl: string;
  try {
    sellerUrl = resolveSellerUrl(config.endpointPath);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failClosed(sellerServiceName, buyerAgentName, costUsdc, timestamp, msg);
  }

  // ── Resolve seller wallet address ──
  let sellerWalletAddress: string;
  try {
    sellerWalletAddress = resolveSellerWallet(config);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failClosed(sellerServiceName, buyerAgentName, costUsdc, timestamp, msg);
  }

  // ── Resolve buyer wallet ID (override from parent node if provided) ──
  let buyerWalletId: string;
  try {
    if (params.buyerWalletIdOverride) {
      buyerWalletId = params.buyerWalletIdOverride;
    } else {
      buyerWalletId = resolveBuyerWalletId(config);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failClosed(sellerServiceName, buyerAgentName, costUsdc, timestamp, msg);
  }

  // ── Get DCW signer ──
  const dcwSigner = getDcwSigner();
  if (!dcwSigner) {
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      "config_error: DCW signer not initialized — call setDcwSigner() before x402 service calls"
    );
  }

  // ── Get buyer wallet address for balance check ──
  let buyerAddress: string;
  try {
    buyerAddress = await dcwSigner.getWalletAddress(buyerWalletId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      `config_error: Failed to resolve buyer wallet address: ${msg}`
    );
  }

  // ── Verify Gateway balance ──
  const maxAmountUsdc = config.priceUsdc > 0 ? config.priceUsdc.toString() : "0.000001";
  const balanceCheck = await verifySufficientBalance(buyerAddress, maxAmountUsdc);
  if (!balanceCheck.ok) {
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      `insufficient_gateway_balance: ${balanceCheck.error}`
    );
  }

  // ── Call seller via buyer-transport (requirePayment=true) ──
  const requestBody = {
    buyerAgentName,
    discoveryRunId,
    payload,
  };

  let callResult;
  try {
    callResult = await callPaidSeller(dcwSigner, {
      sellerUrl,
      method: "POST",
      body: requestBody,
      buyerWalletId,
      buyerAgentName,
      sellerServiceName,
      discoveryRunId,
      maxAmountUsdc,
      requirePayment: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      `x402 transport error: ${msg}`
    );
  }

  // ── Validate buyer-transport result ──
  if (!callResult.ok) {
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      `x402 payment failed: ${callResult.error || "unknown error"}`
    );
  }

  if (callResult.freeResponse) {
    // requirePayment=true should prevent this, but fail closed anyway
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      "x402 fail-closed: seller returned free response on paid edge"
    );
  }

  if (!callResult.paymentMetadata) {
    return failClosed(
      sellerServiceName,
      buyerAgentName,
      costUsdc,
      timestamp,
      "x402 fail-closed: missing payment metadata after settlement"
    );
  }

  // ── Extract seller response data ──
  // x402 seller returns {ok, serviceName, data: handlerOutput, ...}
  // Unwrap to return just the handler output (matching audit-only path)
  const sellerResponse = callResult.data as Record<string, unknown> | null;
  const sellerOk = callResult.ok && (callResult.status === 200 || callResult.status === 409);
  const handlerData = sellerResponse && typeof sellerResponse === "object" && "data" in sellerResponse
    ? (sellerResponse.data as Record<string, unknown> | null)
    : sellerResponse;

  return {
    ok: sellerOk,
    serviceName: sellerServiceName,
    data: handlerData,
    safeSummary: sellerOk
      ? `x402 settled: ${sellerServiceName} via ${buyerAgentName}`
      : `x402 settled but seller returned HTTP ${callResult.status}`,
    settled: true,
    mode: "x402",
    error: sellerOk ? null : `Seller returned HTTP ${callResult.status}`,
    safeCallMeta: {
      buyer: buyerAgentName,
      seller: sellerServiceName,
      edgeValid: true,
      schemaValid: true,
      costUsdc,
      timestamp,
    },
    paymentMeta: callResult.paymentMetadata,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function failClosed(
  serviceName: ServiceName,
  buyer: string,
  costUsdc: number,
  timestamp: string,
  error: string
): CallDelegatedServiceOutput {
  return {
    ok: false,
    serviceName,
    data: null,
    safeSummary: `x402 fail-closed: ${error}`,
    settled: false,
    mode: "x402",
    error,
    safeCallMeta: {
      buyer,
      seller: serviceName,
      edgeValid: true,
      schemaValid: true,
      costUsdc,
      timestamp,
    },
  };
}
