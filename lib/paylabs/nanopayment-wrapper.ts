/**
 * Nanopayment-Aware LangGraph Node Wrapper
 *
 * Wraps a LangGraph node function with x402 nanopayment tracking.
 * When a paid agent node executes:
 *   1. Creates nanopayment row (planned)
 *   2. Signs agent context with HMAC
 *   3. Runs the real LLM node function
 *   4. Updates nanopayment row status (completed/failed)
 *   5. Injects x402 metadata into state for downstream audit
 *
 * Used by graph.ts to wrap the 7 paid agents in the 15-agent pipeline.
 * No separate HTTP endpoints. No skeleton code. Real LLM + real tracking.
 */

import { createHmac, randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  PAID_AGENTS,
  AGENT_NANOPRICE_USDC,
  getPayerForAgent,
  resolveAgentWallet,
  type PaidAgentName,
} from "@/lib/paylabs/agent-registry";
import type { PayLabsTutorStateType } from "@/lib/ai-tutor/state";

// ─── Types ─────────────────────────────────────────────────────

type LangGraphNode = (
  state: PayLabsTutorStateType
) => Promise<Partial<PayLabsTutorStateType>>;

interface NanopaymentContext extends Record<string, unknown> {
  discoveryRunId: string;
  receiptId: string;
  agentName: string;
  payerAgent: string;
  payeeWallet: string;
  signedContext: string;
}

// ─── HMAC Signing ──────────────────────────────────────────────

function signAgentContext(agentName: string, receiptId: string, discoveryRunId: string): string {
  const secret = process.env.PAYLABS_HMAC_SECRET;
  if (!secret) return "";

  const payload = [
    `agent_name:${agentName}`,
    `receipt_id:${receiptId}`,
    `discovery_run_id:${discoveryRunId}`,
    `amount_usdc:${AGENT_NANOPRICE_USDC}`,
    `expires_at:${new Date(Date.now() + 5 * 60 * 1000).toISOString()}`,
  ].join("|");

  return createHmac("sha256", secret).update(payload).digest("hex");
}

// ─── Create Nanopayment Row ────────────────────────────────────

async function createNanopaymentRow(
  agentName: PaidAgentName,
  discoveryRunId: string,
  userWallet: string,
  routeTier: string
): Promise<NanopaymentContext | null> {
  const agentDef = PAID_AGENTS.find((a) => a.name === agentName);
  if (!agentDef) return null;

  const receiptId = randomUUID();
  const payeeWallet = resolveAgentWallet(agentName);
  const payerAgent = getPayerForAgent(agentName);
  const signedContext = signAgentContext(agentName, receiptId, discoveryRunId);

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
    console.error(`[nanopayment] Failed to create row for ${agentName}:`, error.message);
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

// ─── Update Nanopayment Status ─────────────────────────────────

async function updateNanopaymentStatus(
  receiptId: string,
  status: string,
  error?: string
): Promise<void> {
  try {
    await supabaseAdmin()
      .from("paylabs_agent_nanopayments")
      .update({
        status,
        ...(error ? { x402_payment_ref: `error:${error}` } : {}),
      })
      .eq("receipt_id", receiptId);
  } catch {
    console.error(`[nanopayment] Failed to update status for receipt ${receiptId}`);
  }
}

// ─── Wrapper: withNanopayment ──────────────────────────────────
//
// Wraps a LangGraph node function with x402 nanopayment tracking.
// The wrapped function:
//   1. Creates a nanopayment row before execution
//   2. Runs the original node (real LLM call)
//   3. Updates the row status based on result
//   4. Injects x402 metadata into state
//
// Usage in graph.ts:
//   .addNode("tutor_intake", withNanopayment("tutor_intake", tutorIntakeAgent))

export function withNanopayment(
  agentName: PaidAgentName,
  nodeFn: LangGraphNode
): LangGraphNode {
  return async (state: PayLabsTutorStateType) => {
    const discoveryRunId = state.discoveryRunId as string | undefined;
    const userWallet = state.userWallet as string | undefined;
    const routeTier = (state.routeTier as string) || "normal";

    // If no discovery run context, skip nanopayment tracking
    // (e.g. when called from tutor/chat which is free)
    if (!discoveryRunId || !userWallet) {
      return nodeFn(state);
    }

    // ── Step 1: Create nanopayment row ─────────────────────────
    const nanoCtx = await createNanopaymentRow(
      agentName,
      discoveryRunId,
      userWallet,
      routeTier
    );

    // ── Step 2: Run real LLM node ──────────────────────────────
    let result: Partial<PayLabsTutorStateType>;
    try {
      result = await nodeFn(state);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (nanoCtx) {
        await updateNanopaymentStatus(nanoCtx.receiptId, "failed", msg);
      }
      // Re-throw so LangGraph handles the error
      throw e;
    }

    // ── Step 3: Update nanopayment status ──────────────────────
    if (nanoCtx) {
      const hasError = result.error || (result.llmErrors as Record<string, unknown>)?.[agentName];
      const status = hasError ? "failed" : "completed";
      await updateNanopaymentStatus(nanoCtx.receiptId, status);
    }

    // ── Step 4: Inject x402 metadata into state ────────────────
    const existingTrace = (result.agentTrace as Record<string, unknown>) || {};
    const existingNano = (state.nanopaymentContexts as NanopaymentContext[]) || [];

    return {
      ...result,
      agentTrace: {
        ...existingTrace,
        [`${agentName}_x402`]: nanoCtx
          ? {
              receipt_id: nanoCtx.receiptId,
              receipt_url: `/api/paylabs/receipts/${nanoCtx.receiptId}`,
              amount_usdc: AGENT_NANOPRICE_USDC,
              payer: nanoCtx.payerAgent,
              payee_wallet: nanoCtx.payeeWallet,
              signed_context: nanoCtx.signedContext ? "present" : "no_hmac_secret",
            }
          : { skipped: true, reason: "no_discovery_run_context" },
      },
      nanopaymentContexts: [
        ...existingNano,
        ...(nanoCtx ? [nanoCtx] : []),
      ],
    };
  };
}
