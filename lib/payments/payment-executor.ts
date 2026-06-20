/**
 * Payment Executor Factory
 * Selects payment executor based on PAYLABS_PAYMENT_EXECUTOR env.
 *
 * Values:
 *   noop      — fail-closed, no payments (default)
 *   x402      — x402 payment protocol via Circle Gateway
 *   circle_sdk — alias for x402
 *
 * Default: noop (fail-closed)
 * No hardcoded Runner in LangGraph.
 */
import type { PaymentExecutor } from "@/lib/paylabs/x402/types";
import { NoopPaymentExecutor } from "./noop-executor";
import { X402GatewayPaymentExecutor } from "./x402-gateway-executor";

let cachedExecutor: PaymentExecutor | null = null;

export function getPaymentExecutor(): PaymentExecutor {
  if (cachedExecutor) return cachedExecutor;

  const executorType = (process.env.PAYLABS_PAYMENT_EXECUTOR || "noop").toLowerCase();

  switch (executorType) {
    case "x402":
    case "circle_sdk":
      cachedExecutor = new X402GatewayPaymentExecutor();
      break;
    case "noop":
    default:
      cachedExecutor = new NoopPaymentExecutor();
      break;
  }

  return cachedExecutor;
}

/**
 * Check if a real payment executor is configured (not noop).
 */
export function isPaymentExecutorConfigured(): boolean {
  const executorType = (process.env.PAYLABS_PAYMENT_EXECUTOR || "noop").toLowerCase();
  return executorType !== "noop";
}
