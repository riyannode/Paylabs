/**
 * Paid LangGraph Node Wrapper
 *
 * Wraps a real LangGraph node function with x402 nanopayment tracking.
 * This is the SINGLE integration point between the 7 paid agents and
 * the 15-agent LangGraph pipeline. No separate HTTP endpoints.
 *
 * Flow per wrapped node:
 *   1. Create nanopayment audit row (status: running)
 *   2. Create signed agent context via lib/payments/agent-context.ts
 *   3. Execute the REAL LangGraph node function (LLM call)
 *   4. Update nanopayment status (completed/failed) based on real result
 *   5. Emit safe public event record to DB
 *   6. Return result to LangGraph (no raw CoT, no secrets)
 *
 * Safe public event fields only:
 *   run_id, agent_name, node_name, event_type, message,
 *   safe_payload, payment_status, receipt_ref, created_at
 */

import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  PAID_AGENTS,
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
  node_name: string;
  event_type: string;
  message: string;
  safe_payload: Record<string, unknown>;
  payment_status: string;
  receipt_ref: string;
}

/**
 * Emit a safe public event record. Never includes raw CoT, secrets,
 * or internal context. Only safe fields that can be exposed to users.
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

// ─── Create Nanopayment Audit Row ──────────────────────────────

async function createAuditRow(
  agentName: PaidAgentName,
  discoveryRunId: string,
  userWallet: string,
  routeTier: string
): Promise<PaidNodeContext | null> {
  const agentDef = PAID_AGENTS.find((a) => a.name === agentName);
  if (!agentDef) return null;

  const receiptId = randomUUID();
  const payeeWallet = resolveAgentWallet(agentName);
  const payerAgent = getPayerForAgent(agentName);
  const externalTier = toExternalTier(routeTier);

  // Create signed agent context using the canonical signing function
  const signedContext = createAgentContext({
    runId: discoveryRunId,
    agentName,
    routeTier: externalTier,
    settlementMode: "nano",
    payerWallet: userWallet,
    receiptId,
  });

  const receiptUrl = `/api/paylabs/receipts/${receiptId}`;

  const { error } = await supabaseAdmin()
    .from("paylabs_agent_nanopayments")
    .insert({
      discovery_run_id: discoveryRunId,
      receipt_id: receiptId,
      user_wallet: userWallet.toLowerCase(),
      payer_agent: payerAgent,
      payee_agent: agentName,
      route_tier: routeTier,
      agent_name: agentName,
      capability: agentDef.capability,
      agent_wallet: payeeWallet || "",
      price_usdc: 0.000001,
      settlement_mode: "nano",
      payment_route: "circle_gateway_x402",
      payment_kind: "agent_capability_fee",
      receipt_url: receiptUrl,
      status: "running",
    });

  if (error) {
    console.error(`[paid-node] Failed to create audit row for ${agentName}:`, error.message);
    return null;
  }

  return {
    discoveryRunId,
    receiptId,
    agentName,
    payerAgent,
    payeeWallet: payeeWallet || "",
    signedContext,
  };
}

// ─── Update Audit Row Status ───────────────────────────────────

async function updateAuditStatus(
  receiptId: string,
  status: string,
  errorMsg?: string
): Promise<void> {
  try {
    const update: Record<string, unknown> = { status };
    if (errorMsg) {
      // Store error summary only, not raw stack traces
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
// The wrapped function:
//   1. Creates audit row + signed context
//   2. Runs the REAL node function (LLM call)
//   3. Updates audit status based on real result
//   4. Emits safe public event
//   5. Returns result with x402 metadata (no secrets)
//
// Usage in graph.ts:
//   .addNode("tutor_intake", withPaidNode("tutor_intake", tutorIntakeAgent))

export function withPaidNode(
  agentName: PaidAgentName,
  nodeFn: LangGraphNode
): LangGraphNode {
  return async (state: PayLabsTutorStateType) => {
    const discoveryRunId = state.discoveryRunId as string | undefined;
    const userWallet = state.userWallet as string | undefined;
    const routeTier = (state.routeTier as string) || "normal";

    // If no discovery run context, skip paid tracking
    // (e.g. when called from tutor/chat which is free)
    if (!discoveryRunId || !userWallet) {
      return nodeFn(state);
    }

    // ── Step 1: Create audit row + signed context ──────────────
    const ctx = await createAuditRow(
      agentName,
      discoveryRunId,
      userWallet,
      routeTier
    );

    // ── Step 2: Execute REAL LangGraph node ────────────────────
    let result: Partial<PayLabsTutorStateType>;
    try {
      result = await nodeFn(state);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (ctx) {
        await updateAuditStatus(ctx.receiptId, "failed", msg);
        await emitSafeEvent({
          run_id: discoveryRunId,
          agent_name: agentName,
          node_name: agentName,
          event_type: "node_failed",
          message: `Agent execution failed`,
          safe_payload: { reason_summary: msg.slice(0, 200) },
          payment_status: "failed",
          receipt_ref: ctx.receiptId,
        });
      }
      throw e;
    }

    // ── Step 3: Update audit status based on real result ───────
    if (ctx) {
      const hasError =
        result.error ||
        (result.llmErrors as Record<string, unknown>)?.[agentName];
      const status = hasError ? "failed" : "completed";
      await updateAuditStatus(ctx.receiptId, status);

      // Emit safe event — no raw CoT, no secrets
      await emitSafeEvent({
        run_id: discoveryRunId,
        agent_name: agentName,
        node_name: agentName,
        event_type: hasError ? "node_failed" : "node_completed",
        message: hasError
          ? `Agent completed with errors`
          : `Agent executed successfully`,
        safe_payload: {
          decision: hasError ? "error" : "success",
          // Only safe summary fields — never raw LLM output
          ...(result.stopReason ? { reason_summary: result.stopReason } : {}),
        },
        payment_status: status,
        receipt_ref: ctx.receiptId,
      });
    }

    // ── Step 4: Return result with safe x402 metadata ──────────
    const existingTrace = (result.agentTrace as Record<string, unknown>) || {};
    const existingNano = (state.nanopaymentContexts as PaidNodeContext[]) || [];

    return {
      ...result,
      agentTrace: {
        ...existingTrace,
        [`${agentName}_x402`]: ctx
          ? {
              receipt_id: ctx.receiptId,
              receipt_url: `/api/paylabs/receipts/${ctx.receiptId}`,
              amount_usdc: AGENT_NANOPRICE_USDC,
              payer: ctx.payerAgent,
              // signed_context: "present" only — never expose the actual sig
              signed_context: "present",
            }
          : { skipped: true, reason: "no_discovery_run_context" },
      },
      nanopaymentContexts: [
        ...existingNano,
        ...(ctx ? [ctx] : []),
      ],
    };
  };
}
