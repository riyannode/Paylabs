// ArcLayer Runner HTTP client
// All privileged payment/onchain actions go through Runner.
// Runner is the trust boundary — PayLabs never calls Circle, contracts, or wallet APIs directly.

import type {
  RunnerHealthResponse,
  RunnerX402PayInput,
  RunnerX402PayResult,
  RunnerPaymentReceipt,
  RunnerX402Quote,
} from "./types";
import { RunnerError } from "./types";
import { createHmac, randomUUID } from "node:crypto";

function getRunnerConfig() {
  const url = process.env.ARCLAYER_RUNNER_URL;
  const secret = process.env.ARCLAYER_RUNNER_API_KEY;
  if (!url) throw new RunnerError("ARCLAYER_RUNNER_URL not configured", 500);
  if (!secret) throw new RunnerError("ARCLAYER_RUNNER_API_KEY not configured", 500);
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
    "x-arclayer-runner-timestamp": timestamp,
    "x-arclayer-runner-nonce": nonce,
    "x-arclayer-runner-signature": `sha256=${signature}`,
  };
}

export async function runnerFetch<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { url, secret } = getRunnerConfig();
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
    throw new RunnerError(`Runner ${method} ${path} ${res.status}: ${text}`, res.status);
  }

  return res.json() as Promise<T>;
}

/**
 * Check Runner health.
 */
export async function runnerHealth(): Promise<RunnerHealthResponse> {
  return runnerFetch<RunnerHealthResponse>("GET", "/health");
}

/**
 * Get x402 payment quote from Runner.
 */
export async function runnerX402Quote(
  resourceUrl: string,
  method = "GET"
): Promise<RunnerX402Quote> {
  return runnerFetch<RunnerX402Quote>("POST", "/x402/inspect", {
    type: "x402_service_pay",
    url: resourceUrl,
    method,
    maxAmountUsdc: "0",
    reason: "inspect",
  });
}

/**
 * Execute x402 lesson payment through Runner.
 * Runner handles Circle Developer-Controlled Wallet execution and Gateway settlement.
 */
export async function runnerX402PayLesson(
  input: RunnerX402PayInput
): Promise<RunnerX402PayResult> {
  return runnerFetch<RunnerX402PayResult>("POST", "/x402/pay", {
    type: "x402_service_pay",
    url: input.resourceUrl,
    method: "GET",
    maxAmountUsdc: input.amountUsdc,
    reason: `lesson:${input.lessonId}`,
    idempotencyKey: `paylabs:${input.lessonId}:${input.userWallet}`,
    body: {
      lessonId: input.lessonId,
      userWallet: input.userWallet,
      creatorWallet: input.creatorWallet,
      signedAuthorization: input.signedAuthorization,
    },
  });
}

/**
 * Get payment receipt from Runner.
 */
export async function runnerGetPaymentReceipt(
  paymentId: string
): Promise<RunnerPaymentReceipt> {
  return runnerFetch<RunnerPaymentReceipt>("GET", `/x402/receipt/${paymentId}`);
}
