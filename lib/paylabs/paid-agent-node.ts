/**
 * Paid LangGraph Node Wrapper
 *
 * Wraps 7 of the 15 LangGraph agents with x402 nanopayment tracking.
 * The 7 paid agents are audited capability nodes. The other 8 are
 * free/internal LLM agents with deterministic backend guardrails.
 *
 * CRITICAL: This wrapper does NOT create nanopayment rows.
 * Rows are pre-created by discovery-pipeline.ts (status: planned).
 * This wrapper only UPDATES existing rows:
 *   planned → running (before node execution)
 *   running → completed/failed (after node execution)
 *
 * Flow per wrapped node:
 *   1. Look up existing receipt_id from state.paidReceiptIds
 *   2. If found: update row planned → running
 *   3. Create signed agent context using existing receipt_id
 *   4. Execute the REAL LangGraph node function (LLM call)
 *   5. Update row running → completed/failed based on real result
 *   6. Emit safe public event on the same row
 *   7. Return result (no raw CoT, no secrets)
 *
 * Paid agent identity mapping:
 *   source_ranker graph node → discovery_ranker paid identity
 *   creator_ownership_verifier graph node → attribution_auditor paid identity
 */

import { supabaseAdmin } from "@/lib/supabase/server";
import {
  AGENT_NANOPRICE_USDC,
  getPayerForAgent,
  resolveAgentWallet,
  type PaidAgentName,
} from "@/lib/paylabs/agent-registry";
import {
  createAgentContext,
  type AgentContextPayload,
} from "@/lib/payments/agent-context";
import { toExternalTier } from "@/lib/paylabs/route-tier";
import type { PayLabsTutorStateType } from "@/lib/ai-tutor/state";

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

// ─── Wrapper: withPaidNode ─────────────────────────────────────
//
// The 7 paid LangGraph nodes use this wrapper.
// Does NOT create rows — only updates existing planned rows.
//
// Usage in graph.ts:
//   .addNode("tutor_intake", withPaidNode("tutor_intake", tutorIntakeAgent))
//   .addNode("source_ranker", withPaidNode("discovery_ranker", sourceRankerAgent))
//   .addNode("creator_ownership_verifier", withPaidNode("attribution_auditor", ...))

export function withPaidNode(
  agentName: PaidAgentName,
  nodeFn: LangGraphNode
): LangGraphNode {
  return async (state: PayLabsTutorStateType) => {
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
      // Fail closed: signed context is required for paid nodes in production.
      // Mark the row as config_error and throw so the pipeline fails visibly.
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
        },
      },
      nanopaymentContexts: [...existingNano, ctx],
    };
  };
}
