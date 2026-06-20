/**
 * Paid LangGraph Node Wrapper
 *
 * Wraps 7 of the 15 LangGraph agents with x402 nanopayment tracking.
 * The 7 paid agents are audited capability nodes. The other 8 are
 * free/internal LLM agents with deterministic backend guardrails.
 *
 * TWO MODES (controlled by PAYLABS_AGENT_NANOPAYMENTS_ENABLED):
 *
 * Mode 1: Audit-only (flag = false, default)
 *   - Creates signed agent context (HMAC)
 *   - Executes the LangGraph node (LLM call)
 *   - Updates status: planned → running → completed/failed
 *   - No real x402 payment, no Gateway interaction
 *
 * Mode 2: Real x402 payment (flag = true)
 *   - Verifies Gateway balance for buyer wallet
 *   - Calls seller endpoint via x402 buyer transport
 *   - Seller returns 402 challenge → buyer signs → seller verifies/settles
 *   - Stores safe payment refs in ledger
 *   - Then executes the LangGraph node
 *   - Statuses: planned → running → completed/failed
 *   - Fails closed: insufficient_gateway_balance, config_error
 *
 * CRITICAL: This wrapper does NOT create nanopayment rows.
 * Rows are pre-created by discovery-pipeline.ts (status: planned).
 * This wrapper only UPDATES existing rows.
 *
 * Paid agent identity mapping:
 *   source_ranker graph node → discovery_ranker paid identity
 *   creator_ownership_verifier graph node → attribution_auditor paid identity
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  AGENT_NANOPRICE_USDC,
  AGENT_NANOPRICE_NUMBER,
  getPayerForAgent,
  resolveAgentWallet,
  resolveAgentWalletId,
  type PaidAgentName,
} from "@/lib/paylabs/agent-registry";
import {
  createAgentContext,
  type AgentContextPayload,
} from "@/lib/paylabs/x402/agent-context";
import {
  callPaidSeller,
  type DcwSigner,
  type X402BuyerCallResult,
} from "@/lib/paylabs/x402/buyer-transport";
import {
  verifySufficientBalance,
} from "@/lib/paylabs/x402/gateway-balance";
import {
  updateNanopaymentWithSafeRefs,
} from "@/lib/paylabs/nanopayment-service";
import { getPaymentFlags } from "@/lib/paylabs/feature-flags";
import { toExternalTier } from "@/lib/paylabs/route-tier";
import type { PayLabsTutorStateType } from "@/lib/ai/state";

// ─── Types ─────────────────────────────────────────────────────

type LangGraphNode = (
  state: PayLabsTutorStateType
) => Promise<Partial<PayLabsTutorStateType>>;

interface PaidNodeContext extends Record<string, unknown> {
  discoveryRunId: string;
  receiptId: string;
  agentName: PaidAgentName;
  payerAgent: string;
  payeeWallet: string;
  signedContext: AgentContextPayload;
  x402Payment?: {
    settled: boolean;
    amountAtomic?: string;
    payTo?: string;
    network?: string;
  };
}

// ─── DCW Signer Injection ─────────────────────────────────────
// Module-level setter. Called once from the app layer to inject
// the DCW signer adapter. Keeps lib/ independent of apps/.

let _dcwSigner: DcwSigner | null = null;

/**
 * Inject the DCW signer adapter from the app layer.
 * Must be called before any real x402 payment is attempted.
 * The signer handles signTypedData and getWalletAddress via Circle DCW API.
 */
export function setDcwSigner(signer: DcwSigner): void {
  _dcwSigner = signer;
}

/**
 * Get the injected DCW signer. Returns null if not injected.
 */
export function getDcwSigner(): DcwSigner | null {
  return _dcwSigner;
}

// ─── Seller Endpoint Resolution ────────────────────────────────

/**
 * Resolve the seller endpoint URL for a paid agent capability.
 * The seller is the PayLabs agent-capability endpoint itself.
 * When x402 is enabled, the buyer calls this endpoint which returns
 * 402 with payment requirements, then retries with payment.
 */
function getSellerEndpoint(agentName: PaidAgentName): string {
  const baseUrl = process.env.NEXT_PUBLIC_PAYLABS_APP_URL || "";
  // Map paid agent names to their capability endpoint paths
  const endpointMap: Record<string, string> = {
    tutor_intake: "/api/paylabs/agent-capabilities/tutor-intake",
    intent_classifier: "/api/paylabs/agent-capabilities/intent-classifier",
    query_expander: "/api/paylabs/agent-capabilities/query-expander",
    discovery_ranker: "/api/paylabs/agent-capabilities/discovery-ranker",
    source_quality_verifier: "/api/paylabs/agent-capabilities/source-quality-verifier",
    provenance_verifier: "/api/paylabs/agent-capabilities/provenance-verifier",
    attribution_auditor: "/api/paylabs/agent-capabilities/attribution-auditor",
  };
  const path = endpointMap[agentName];
  if (!path) {
    throw new Error(`No seller endpoint for paid agent: ${agentName}`);
  }
  return `${baseUrl}${path}`;
}

// ─── Safe Public Event ─────────────────────────────────────────

interface SafePublicEvent {
  run_id: string;
  agent_name: string;
  event_type: string;
  message: string;
  safe_payload: Record<string, unknown>;
  payment_status: string;
  receipt_ref: string;
}

/**
 * Emit a safe public event by updating the existing nanopayment row's
 * metadata field. Never includes raw CoT, secrets, or internal context.
 */
async function emitSafeEvent(event: SafePublicEvent): Promise<void> {
  try {
    await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .update({
        metadata: {
          event_type: event.event_type,
          message: event.message,
          safe_payload: event.safe_payload,
          public_event: true,
        },
      })
      .eq("receipt_id", event.receipt_ref);
  } catch {
    // Non-fatal — audit row already exists
  }
}

// ─── Update Existing Row Status ────────────────────────────────

async function updateRowStatus(
  receiptId: string,
  status: string,
  errorMsg?: string
): Promise<void> {
  try {
    const update: Record<string, unknown> = { status };
    if (errorMsg) {
      update.metadata = { error_summary: errorMsg.slice(0, 200) };
    }
    await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .update(update)
      .eq("receipt_id", receiptId);
  } catch {
    console.error(`[paid-node] Failed to update status for receipt ${receiptId}`);
  }
}

// ─── Real x402 Payment Flow ────────────────────────────────────

/**
 * Execute a real x402 payment for a paid agent edge.
 *
 * Flow:
 *   1. Verify Gateway balance for buyer wallet
 *   2. Call seller endpoint via buyer transport (402 challenge → sign → retry)
 *   3. Store safe payment refs in ledger
 *   4. Return payment result
 *
 * Fails closed on any error.
 */
async function executeX402Payment(
  agentName: PaidAgentName,
  receiptId: string,
  discoveryRunId: string
): Promise<{
  ok: boolean;
  paymentResult?: X402BuyerCallResult;
  error?: string;
}> {
  // ── Pre-check: DCW signer must be injected ─────────────────
  if (!_dcwSigner) {
    return {
      ok: false,
      error: "DCW signer not injected — call setDcwSigner() from app layer",
    };
  }

  // ── Resolve buyer wallet ───────────────────────────────────
  const buyerWalletId = resolveAgentWalletId(agentName);
  if (!buyerWalletId) {
    return {
      ok: false,
      error: `No wallet ID configured for agent: ${agentName}`,
    };
  }

  // ── Verify Gateway balance ─────────────────────────────────
  const buyerAddress = resolveAgentWallet(agentName);
  if (!buyerAddress) {
    return {
      ok: false,
      error: `No wallet address configured for agent: ${agentName}`,
    };
  }

  const balanceCheck = await verifySufficientBalance(
    buyerAddress,
    AGENT_NANOPRICE_USDC
  );

  if (!balanceCheck.ok) {
    // Store insufficient balance status
    await updateNanopaymentWithSafeRefs(receiptId, "insufficient_gateway_balance", {
      errorSummary: balanceCheck.error,
    });
    await emitSafeEvent({
      run_id: discoveryRunId,
      agent_name: agentName,
      event_type: "insufficient_balance",
      message: "Buyer wallet has insufficient Gateway balance",
      safe_payload: {
        required_usdc: AGENT_NANOPRICE_USDC,
        available_usdc: balanceCheck.balanceUsdc || "0",
      },
      payment_status: "insufficient_gateway_balance",
      receipt_ref: receiptId,
    });
    return {
      ok: false,
      error: balanceCheck.error,
    };
  }

  // ── Resolve seller endpoint ────────────────────────────────
  const sellerUrl = getSellerEndpoint(agentName);
  const payeeWallet = resolveAgentWallet(agentName);

  // ── Execute x402 buyer flow ────────────────────────────────
  const paymentResult = await callPaidSeller(_dcwSigner, {
    sellerUrl,
    method: "POST",
    body: {
      agent_name: agentName,
      discovery_run_id: discoveryRunId,
      receipt_id: receiptId,
    },
    headers: {
      "x-paylabs-agent-context": JSON.stringify(
        createAgentContext({
          runId: discoveryRunId,
          agentName,
          routeTier: toExternalTier("normal"),
          settlementMode: "nano",
          payerWallet: buyerAddress,
          receiptId,
        })
      ),
      "x-paylabs-receipt-link": `/api/paylabs/receipts/${receiptId}`,
    },
    buyerWalletId,
    buyerAgentName: agentName,
    sellerServiceName: agentName,
    discoveryRunId,
    maxAmountUsdc: AGENT_NANOPRICE_USDC,
  });

  if (!paymentResult.ok) {
    // Payment failed — store safe error and fail closed
    await updateNanopaymentWithSafeRefs(receiptId, "failed", {
      errorSummary: paymentResult.error || "x402 payment failed",
    });
    await emitSafeEvent({
      run_id: discoveryRunId,
      agent_name: agentName,
      event_type: "x402_payment_failed",
      message: "x402 payment failed",
      safe_payload: {
        error_summary: (paymentResult.error || "unknown").slice(0, 200),
        free_response: paymentResult.freeResponse || false,
      },
      payment_status: "failed",
      receipt_ref: receiptId,
    });
    return {
      ok: false,
      paymentResult,
      error: paymentResult.error,
    };
  }

  // ── Store safe payment refs ────────────────────────────────
  if (!paymentResult.freeResponse && paymentResult.paymentMetadata) {
    await updateNanopaymentWithSafeRefs(receiptId, "running", {
      safePayment: paymentResult.paymentMetadata,
    });
  }

  return { ok: true, paymentResult };
}

// ─── Wrapper: withPaidNode ─────────────────────────────────────

export function withPaidNode(
  agentName: PaidAgentName,
  nodeFn: LangGraphNode
): LangGraphNode {
  return async (state: PayLabsTutorStateType) => {
    const flags = getPaymentFlags();
    const discoveryRunId = state.discoveryRunId as string | undefined;
    const userWallet = state.userWallet as string | undefined;
    const routeTier = (state.routeTier as string) || "normal";
    const paidReceiptIds = state.paidReceiptIds as Record<string, string> | undefined;

    // Look up the planned receipt_id for this paid agent
    const receiptId = paidReceiptIds?.[agentName];

    // If no discovery run context or no planned row, skip paid tracking
    // (e.g. when called from tutor/chat which is free)
    if (!discoveryRunId || !userWallet || !receiptId) {
      return nodeFn(state);
    }

    // ── Step 1: Update planned → running ───────────────────────
    await updateRowStatus(receiptId, "running");

    // Create signed context using the existing receipt_id
    const payeeWallet = resolveAgentWallet(agentName);
    const payerAgent = getPayerForAgent(agentName);
    const externalTier = toExternalTier(routeTier);

    let signedContext: AgentContextPayload;
    try {
      signedContext = createAgentContext({
        runId: discoveryRunId,
        agentName,
        routeTier: externalTier,
        settlementMode: "nano",
        payerWallet: userWallet,
        receiptId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateRowStatus(receiptId, "config_error", msg);
      await emitSafeEvent({
        run_id: discoveryRunId,
        agent_name: agentName,
        event_type: "config_error",
        message: "Signed context creation failed — cannot execute paid node",
        safe_payload: { reason_summary: msg.slice(0, 200) },
        payment_status: "config_error",
        receipt_ref: receiptId,
      });
      throw new Error(
        `[paid-node] ${agentName}: createAgentContext failed — ${msg}. ` +
        `Paid nodes require valid HMAC secret in production.`
      );
    }

    const ctx: PaidNodeContext = {
      discoveryRunId,
      receiptId,
      agentName,
      payerAgent,
      payeeWallet: payeeWallet || "",
      signedContext,
    };

    // ── Step 1b: Real x402 payment (if flag enabled) ───────────
    if (flags.agentNanopaymentsEnabled) {
      const x402Result = await executeX402Payment(
        agentName,
        receiptId,
        discoveryRunId
      );

      if (!x402Result.ok) {
        // x402 payment failed — fail closed, do NOT execute the agent
        throw new Error(
          `[paid-node] ${agentName}: x402 payment failed — ${x402Result.error}. ` +
          `Agent will not execute without valid payment.`
        );
      }

      // Attach x402 metadata to context
      if (x402Result.paymentResult?.paymentMetadata) {
        ctx.x402Payment = {
          settled: true,
          ...x402Result.paymentResult.paymentMetadata,
        };
      }
    }

    // ── Step 2: Execute REAL LangGraph node ────────────────────
    let result: Partial<PayLabsTutorStateType>;
    try {
      result = await nodeFn(state);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await updateRowStatus(receiptId, "failed", msg);
      await emitSafeEvent({
        run_id: discoveryRunId,
        agent_name: agentName,
        event_type: "node_failed",
        message: "Agent execution failed",
        safe_payload: { reason_summary: msg.slice(0, 200) },
        payment_status: "failed",
        receipt_ref: receiptId,
      });
      throw e;
    }

    // ── Step 3: Update running → completed/failed ──────────────
    const hasError =
      result.error ||
      (result.llmErrors as Record<string, unknown>)?.[agentName];
    const status = hasError ? "failed" : "completed";
    await updateRowStatus(receiptId, status);

    await emitSafeEvent({
      run_id: discoveryRunId,
      agent_name: agentName,
      event_type: hasError ? "node_failed" : "node_completed",
      message: hasError
        ? "Agent completed with errors"
        : "Agent executed successfully",
      safe_payload: {
        decision: hasError ? "error" : "success",
        ...(result.stopReason ? { reason_summary: result.stopReason } : {}),
      },
      payment_status: status,
      receipt_ref: receiptId,
    });

    // ── Step 4: Return result with safe x402 metadata ──────────
    const existingTrace = (result.agentTrace as Record<string, unknown>) || {};
    const existingNano = (state.nanopaymentContexts as PaidNodeContext[]) || [];

    return {
      ...result,
      agentTrace: {
        ...existingTrace,
        [`${agentName}_x402`]: {
          receipt_id: receiptId,
          receipt_url: `/api/paylabs/receipts/${receiptId}`,
          amount_usdc: AGENT_NANOPRICE_USDC,
          payer: payerAgent,
          signed_context: "present",
          x402_enabled: flags.agentNanopaymentsEnabled,
          ...(ctx.x402Payment ? { x402_settled: ctx.x402Payment.settled } : {}),
        },
      },
      nanopaymentContexts: [...existingNano, ctx],
    };
  };
}
