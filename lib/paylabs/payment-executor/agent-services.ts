/**
 * PayLabs Backend Payment Executor — Agent-to-Agent Service Payments
 *
 * All payment execution goes through the executor — never local keys, never Circle directly.
 * Uses Circle DCW signer + Circle Gateway x402 under the hood.
 */

import { executorFetch } from "./client";
import { PaymentExecutorError } from "./types";

export interface AgentServicePurchaseInput {
  buyerAgentId: string;
  providerAgentId: string;
  userWallet: string;
  resourceUrl: string;
  amountUsdc: string;
  providerWallet: string;
  inputHash: string;
}

export interface AgentServicePurchaseResult {
  ok: boolean;
  paymentId?: string;
  paymentRef?: string;
  settlementRef?: string;
  txHash?: string;
  error?: string;
}

/**
 * Execute agent-to-agent service purchase through the backend payment executor.
 * This is the ONLY path for agent-to-agent payments.
 *
 * Uses Circle DCW signer for signing and Circle Gateway x402 for settlement.
 * Never uses local private keys.
 * Never generates fallback payment IDs.
 * Returns structured result — caller must validate proof completeness.
 */
export async function executeAgentServicePurchase(
  input: AgentServicePurchaseInput
): Promise<AgentServicePurchaseResult> {
  // Validate inputs
  if (!input.userWallet.startsWith("0x") || input.userWallet.length !== 42) {
    return { ok: false, error: "Invalid user wallet address" };
  }
  if (!input.providerWallet.startsWith("0x") || input.providerWallet.length !== 42) {
    return { ok: false, error: "Invalid provider wallet address" };
  }
  // Block zero address — never send payment to 0x000...000
  if (input.providerWallet.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return { ok: false, error: "Provider wallet is zero address — payment blocked" };
  }
  if (!input.resourceUrl) {
    return { ok: false, error: "Missing resourceUrl" };
  }
  if (!input.amountUsdc || Number(input.amountUsdc) <= 0) {
    return { ok: false, error: "Invalid amount" };
  }

  // Deterministic idempotency key — same input always produces same key
  const idempotencyKey = `agent-service:${input.buyerAgentId}:${input.providerAgentId}:${input.inputHash}:${input.amountUsdc}`;

  try {
    // Use executor fetch boundary — same HMAC auth, same trust boundary
    const result = await executorFetch<AgentServicePurchaseResult>(
      "POST",
      "/x402/pay",
      {
        type: "agent_service_pay",
        url: input.resourceUrl,
        method: "POST",
        maxAmountUsdc: input.amountUsdc,
        reason: `agent-service:${input.buyerAgentId}:${input.providerAgentId}`,
        idempotencyKey,
        body: {
          buyerAgentId: input.buyerAgentId,
          providerAgentId: input.providerAgentId,
          userWallet: input.userWallet,
          providerWallet: input.providerWallet,
          inputHash: input.inputHash,
        },
      }
    );

    // Validate proof completeness
    if (!result.ok) {
      return { ok: false, error: result.error || "Payment execution failed" };
    }
    if (!result.paymentId) {
      return { ok: false, error: "Executor returned no paymentId — proof incomplete" };
    }
    if (!result.paymentRef && !result.settlementRef) {
      return { ok: false, error: "Executor returned no paymentRef or settlementRef — proof incomplete" };
    }

    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
