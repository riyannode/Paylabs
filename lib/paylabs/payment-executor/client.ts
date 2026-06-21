/**
 * PayLabs Backend Payment Executor — HTTP Client
 *
 * All privileged payment/onchain actions go through the executor.
 * The executor is the trust boundary — PayLabs never calls Circle,
 * contracts, or wallet APIs directly.
 *
 * Uses Circle DCW signer + Circle Gateway x402 under the hood.
 */

import type {
  PaymentExecutorHealthResponse,
  PaymentExecutorX402PayResult,
  PaymentExecutorReceipt,
  PaymentExecutorX402Quote,
} from "./types";
import { PaymentExecutorError } from "./types";
import { createHmac, randomUUID } from "node:crypto";

function getExecutorConfig() {
  const url = process.env.PAYLABS_PAYMENT_EXECUTOR_URL;
  const secret = process.env.PAYLABS_PAYMENT_EXECUTOR_API_KEY;
  if (!url) throw new PaymentExecutorError("PAYLABS_PAYMENT_EXECUTOR_URL not configured", 500);
  if (!secret) throw new PaymentExecutorError("PAYLABS_PAYMENT_EXECUTOR_API_KEY not configured", 500);
  return { url: url.replace(/\/$/, ""), secret };
}

function buildHmacHeaders(
  secret: string,
  method: string,
  path: string,
  body: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const bodyHash = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return {
    "Content-Type": "application/json",
    "x-paylabs-executor-timestamp": timestamp,
    "x-paylabs-executor-nonce": nonce,
    "x-paylabs-executor-signature": `sha256=${signature}`,
  };
}

export async function executorFetch<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { url, secret } = getExecutorConfig();
  const bodyStr = body ? JSON.stringify(body) : "";
  const fullUrl = `${url}${path}`;
  const headers = buildHmacHeaders(secret, method, path, bodyStr);

  const res = await fetch(fullUrl, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new PaymentExecutorError(`Executor ${method} ${path} ${res.status}: ${text}`, res.status);
  }

  return res.json() as Promise<T>;
}

/**
 * Check backend payment executor health.
 */
export async function executorHealth(): Promise<PaymentExecutorHealthResponse> {
  return executorFetch<PaymentExecutorHealthResponse>("GET", "/health");
}

/**
 * Get Circle x402 payment quote from the executor.
 */
export async function executorX402Quote(
  resourceUrl: string,
  method = "GET"
): Promise<PaymentExecutorX402Quote> {
  return executorFetch<PaymentExecutorX402Quote>("POST", "/x402/inspect", {
    type: "x402_service_pay",
    url: resourceUrl,
    method,
    maxAmountUsdc: "0",
    reason: "inspect",
  });
}

/**
 * Get payment receipt from the executor.
 */
export async function executorGetPaymentReceipt(
  paymentId: string
): Promise<PaymentExecutorReceipt> {
  return executorFetch<PaymentExecutorReceipt>("GET", `/x402/receipt/${paymentId}`);
}
