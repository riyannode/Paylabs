/**
 * Agent 5: Payment Executor Agent (LLM reasoning + deterministic execution)
 * Executes source payment via ArcLayer Runner after Policy Guard approval.
 *
 * LLM provides reasoning/explanation, but final payment execution
 * is deterministic through Runner. LLM CANNOT skip Runner.
 *
 * Safety rules:
 * - Runner is the ONLY payment executor
 * - No local private keys
 * - No fake payment IDs
 * - No fake tx hashes
 * - No DB-only unlocks
 * - No secrets in logs
 */

import type { PayLabsTutorStateType } from "./state";
import type { RouteTier } from "./route-config";
import { getPromptsForRoute } from "./route-prompts";
import { invokeJsonAgent } from "./llm-json";
import { getSourcePathItems } from "./tools";
import { executeSourcePaymentViaRunner } from "@/lib/arclayer-runner/tools";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";
import { z } from "zod";

// ─── Zod schema for LLM structured output ───────────────────────

const PaymentSchema = z.object({
  payment_summary: z.string().describe("Summary of the payment execution"),
  user_facing_reason: z.string().describe("User-facing reason for the payment"),
  risk_flags: z.array(z.string()).describe("Any risk flags identified"),
});

type PaymentResult = z.infer<typeof PaymentSchema>;

// ─── Main agent ─────────────────────────────────────────────────

export async function paymentExecutorAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const {
    userWallet,
    sourcePathId,
    sourcePathItemId,
    policyDecision,
    routeTier,
    routePrompts,
  } = state;
  const tier: RouteTier = routeTier || "normal";
  const prompts =
    (routePrompts as unknown as ReturnType<typeof getPromptsForRoute>) ||
    getPromptsForRoute(tier);

  // ── Gate: Policy Guard must have approved ──
  if (!policyDecision || !policyDecision.allowed) {
    return {
      error: "Payment blocked: Policy Guard did not approve",
      runnerPaymentResult: { ok: false, error: "Policy not approved" },
    };
  }

  if (!sourcePathId || !sourcePathItemId) {
    return {
      error: "Missing source_path_id or source_path_item_id",
      runnerPaymentResult: { ok: false, error: "Missing required IDs" },
    };
  }

  // ── Load source path item from DB — NEVER trust LLM for price/wallet/URL ──
  let pathItem: Record<string, unknown> | null = null;
  try {
    const items = (await getSourcePathItems(sourcePathId)) as Record<string, unknown>[];
    pathItem = items.find((pi) => pi.id === sourcePathItemId) || null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to load source path item: ${msg}` };
  }

  if (!pathItem) {
    return { error: "Source path item not found in path" };
  }

  const feedItem = pathItem.feed_item as Record<string, unknown> | undefined;

  // ── Resolve price/wallet/URL from DB — NEVER from LLM ──
  const amountUsdc = Number(
    feedItem?.price_per_citation_usdc || pathItem.citation_price_usdc || 0
  );
  const creatorWallet = String(
    feedItem?.creator_wallet || pathItem.creator_wallet || ""
  );
  const sourceUrl = String(
    feedItem?.canonical_url || pathItem.source_url || ""
  );

  if (amountUsdc <= 0) {
    return { error: "Invalid source price from DB" };
  }
  if (!creatorWallet || !creatorWallet.startsWith("0x")) {
    return { error: "Invalid creator wallet from DB" };
  }
  if (!sourceUrl) {
    return { error: "Invalid source URL from DB" };
  }

  // ── Compute deterministic input hash ──
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        userWallet: userWallet.toLowerCase(),
        sourcePathId,
        sourcePathItemId,
        feedItemId: feedItem?.id,
        sourceUrl,
        amountUsdc,
        creatorWallet,
      })
    )
    .digest("hex");

  // ── Call LLM for reasoning — NOT for final payment ──
  const llmResult = await invokeJsonAgent<PaymentResult>({
    agentName: "payment_executor",
    routeTier: tier,
    prompt: prompts.paymentExecutor,
    userMessage: `Route tier: ${tier}\nUser wallet: ${userWallet}\nSource path ID: ${sourcePathId}\nSource path item ID: ${sourcePathItemId}\nAmount: ${amountUsdc} USDC\nCreator wallet: ${creatorWallet}\nSource URL: ${sourceUrl}\n\nPolicy decision: ${JSON.stringify(policyDecision)}\n\nProvide payment reasoning and user-facing explanation. The actual payment will be executed by ArcLayer Runner.`,
    schema: PaymentSchema,
  });

  let llmMeta: Record<string, unknown> = {};
  if (llmResult.ok) {
    const okResult = llmResult as {
      ok: true;
      data: PaymentResult;
      meta: Record<string, unknown>;
    };
    llmMeta = okResult.meta;
  } else {
    const errResult = llmResult as {
      ok: false;
      error: string;
      meta: Record<string, unknown>;
    };
    llmMeta = errResult.meta;
  }

  // ── Execute payment via ArcLayer Runner — the ONLY payment path ──
  let runnerResult: Record<string, unknown>;
  try {
    const result = await executeSourcePaymentViaRunner({
      userWallet,
      sourcePathId,
      sourcePathItemId,
      amountUsdc: String(amountUsdc),
      creatorWallet,
      sourceUrl,
      inputHash,
    });

    runnerResult = result as unknown as Record<string, unknown>;

    if (!result.ok) {
      return {
        error: `Runner payment failed: ${result.error}`,
        runnerPaymentResult: runnerResult,
        agentTrace: { payment_executor: { ...llmMeta, runner_error: result.error } },
      };
    }

    // CRITICAL: Require complete proof
    if (!result.paymentId) {
      return {
        error: "Runner returned no paymentId — cannot record payment",
        runnerPaymentResult: runnerResult,
        agentTrace: { payment_executor: { ...llmMeta, runner_error: "no paymentId" } },
      };
    }

    if (!result.paymentRef && !result.settlementRef) {
      return {
        error: "Runner returned no paymentRef or settlementRef — proof incomplete",
        runnerPaymentResult: runnerResult,
        agentTrace: { payment_executor: { ...llmMeta, runner_error: "no payment proof" } },
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: `Runner execution error: ${msg}`,
      runnerPaymentResult: { ok: false, error: msg },
      agentTrace: { payment_executor: { ...llmMeta, runner_error: msg } },
    };
  }

  // ── Persist payment to DB — only after valid Runner proof ──
  const { data: paymentRow, error: insertErr } = await supabaseAdmin()
    .from("paylabs_source_payments")
    .insert({
      user_wallet: userWallet.toLowerCase(),
      path_id: sourcePathId,
      source_path_item_id: sourcePathItemId,
      feed_item_id: feedItem?.id || null,
      payment_kind: "citation",
      source_url: sourceUrl,
      source_title: String(feedItem?.title || ""),
      creator_wallet: creatorWallet.toLowerCase(),
      route_tier: tier,
      amount_usdc: amountUsdc,
      payment_id: runnerResult.paymentId as string,
      payment_ref: (runnerResult.paymentRef as string) || null,
      settlement_ref: (runnerResult.settlementRef as string) || null,
      tx_hash: (runnerResult.txHash as string) || null,
      status: "completed",
    })
    .select("id")
    .single();

  if (insertErr || !paymentRow) {
    return {
      error: `Payment succeeded but failed to persist: ${insertErr?.message || "unknown"}. Audit trail required.`,
      runnerPaymentResult: runnerResult,
    };
  }

  // ── Update source path item status ──
  await supabaseAdmin()
    .from("paylabs_source_path_items")
    .update({ status: "cited" })
    .eq("id", sourcePathItemId);

  return {
    sourcePaymentId: paymentRow.id,
    receiptId: paymentRow.id,
    runnerPaymentResult: runnerResult,
    agentTrace: { payment_executor: { ...llmMeta, payment_id: runnerResult.paymentId, db_id: paymentRow.id } },
  };
}
