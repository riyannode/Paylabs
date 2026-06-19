/**
 * ArcLayer Runner adapter for agent-to-agent service payments.
 * All payment execution goes through Runner — never local keys, never Circle directly.
 *
 * RFB 03: Agent-to-Agent Nanopayment Networks
 */

import { runnerFetch } from "./client";
import { RunnerError } from "./types";
import { randomUUID } from "node:crypto";

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
 * Execute agent-to-agent service purchase through ArcLayer Runner.
 * This is the ONLY path for agent-to-agent payments.
 *
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
  if (!input.resourceUrl) {
    return { ok: false, error: "Missing resourceUrl" };
  }
  if (!input.amountUsdc || Number(input.amountUsdc) <= 0) {
    return { ok: false, error: "Invalid amount" };
  }

  const idempotencyKey = randomUUID();

  try {
    // Use existing Runner fetch boundary — same HMAC auth, same trust boundary
    const result = await runnerFetch<AgentServicePurchaseResult>(
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
      return { ok: false, error: result.error || "Runner payment failed" };
    }
    if (!result.paymentId) {
      return { ok: false, error: "Runner returned no paymentId — proof incomplete" };
    }
    if (!result.paymentRef && !result.settlementRef) {
      return { ok: false, error: "Runner returned no paymentRef or settlementRef — proof incomplete" };
    }

    return result;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
