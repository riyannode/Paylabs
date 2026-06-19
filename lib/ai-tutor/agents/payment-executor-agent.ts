/**
 * Agent 14: Payment Executor Agent
 * Reasoning only. Backend payment adapter executes actual payment.
 * Payment adapter selected via PAYLABS_PAYMENT_EXECUTOR env.
 */
import { z } from "zod";
import type { PayLabsTutorStateType } from "../state";
import { generateStructuredJson } from "../llm-structured";
import { getPaymentExecutor } from "@/lib/payments/payment-executor";
import { getSourcePathItems } from "../tools";
import { computeSplit } from "../route-config";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

const Schema = z.object({
  payment_summary: z.string(),
  user_facing_reason: z.string(),
  risk_flags: z.array(z.string()),
});

const SYSTEM_PROMPT = `You are PayLabs Payment Executor Agent. You provide payment execution reasoning only. Actual payment execution is deterministic through the PayLabs Payment Adapter. You cannot execute payment yourself and cannot bypass policy. Payment can only proceed after Policy Guard approval. Payment must use DB-loaded wallet, source URL, price, and source identity. Payment must require real payment_id and payment_ref or settlement_ref. No fake tx hashes. No DB-only receipts. Return structured JSON only.`;

export async function paymentExecutorAgent(state: PayLabsTutorStateType) {
  const { userWallet, sourcePathId, sourcePathItemId, policyDecision, routeTier, paymentQuote } = state;
  const tier = routeTier || "normal";

  if (!policyDecision || !policyDecision.allowed) {
    return { error: "Payment blocked: Policy Guard did not approve", paymentAdapterResult: { ok: false, error: "Policy not approved" } };
  }
  if (!sourcePathId || !sourcePathItemId) {
    return { error: "Missing source_path_id or source_path_item_id" };
  }

  // Load source path item from DB
  let pathItem: Record<string, unknown> | null = null;
  try {
    const items = await getSourcePathItems(sourcePathId) as Record<string, unknown>[];
    pathItem = items.find((pi) => pi.id === sourcePathItemId) || null;
  } catch (e: unknown) {
    return { error: `Failed to load source path item: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!pathItem) return { error: "Source path item not found" };

  const feedItem = pathItem.feed_item as Record<string, unknown> | undefined;
  const amountUsdc = Number(feedItem?.price_per_citation_usdc || pathItem.citation_price_usdc || 0);
  const creatorWallet = String(feedItem?.creator_wallet || pathItem.creator_wallet || "");
  const sourceUrl = String(feedItem?.canonical_url || pathItem.source_url || "");

  if (amountUsdc <= 0) return { error: "Invalid source price from DB" };
  if (!creatorWallet || !creatorWallet.startsWith("0x")) return { error: "Invalid creator wallet from DB" };
  if (!sourceUrl) return { error: "Invalid source URL from DB" };

  // LLM reasoning
  const result = await generateStructuredJson<z.infer<typeof Schema>>({
    agentName: "payment_executor",
    routeTier: tier,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Route: ${tier}\nAmount: ${amountUsdc} USDC\nCreator: ${creatorWallet}\nSource: ${sourceUrl}\nPolicy: ${JSON.stringify(policyDecision)}\n\nProvide payment reasoning. Return structured JSON only.`,
    schema: Schema,
  });

  // Payment adapter execution
  const executor = getPaymentExecutor();
  const split = computeSplit(amountUsdc);

  const payResult = await executor.pay({
    userWallet,
    sourcePathId,
    sourcePathItemId,
    amountUsdc,
    creatorWallet,
    sourceUrl,
    creatorAmountUsdc: split.creator_amount_usdc,
    agentFeeUsdc: split.agent_fee_usdc,
    treasuryFeeUsdc: split.treasury_fee_usdc,
  });

  if (!payResult.ok) {
    return {
      error: `Payment adapter failed: ${payResult.error}`,
      paymentAdapterResult: payResult as unknown as Record<string, unknown>,
      agentTrace: { payment_executor: { ...(result.ok ? result.meta : {}), adapter_error: payResult.error } },
    };
  }

  // Persist payment to DB
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ userWallet: userWallet.toLowerCase(), sourcePathId, sourcePathItemId, amountUsdc, creatorWallet }))
    .digest("hex");

  const { data: paymentRow, error: insertErr } = await supabaseAdmin()
    .from("paylabs_source_payments")
    .insert({
      user_wallet: userWallet.toLowerCase(),
      source_path_id: sourcePathId,
      source_path_item_id: sourcePathItemId,
      feed_item_id: feedItem?.id || null,
      payment_kind: "citation",
      source_url: sourceUrl,
      source_title: String(feedItem?.title || ""),
      creator_wallet: creatorWallet.toLowerCase(),
      route_tier: tier,
      amount_usdc: amountUsdc,
      creator_amount_usdc: split.creator_amount_usdc,
      agent_fee_usdc: split.agent_fee_usdc,
      treasury_fee_usdc: split.treasury_fee_usdc,
      split_rule_version: "v1_85_10_5",
      payment_id: payResult.paymentId,
      payment_ref: payResult.paymentRef || null,
      settlement_ref: payResult.settlementRef || null,
      tx_hash: payResult.txHash || null,
      status: "completed",
    })
    .select("id")
    .single();

  if (insertErr || !paymentRow) {
    return {
      error: `Payment succeeded but failed to persist: ${insertErr?.message || "unknown"}`,
      paymentAdapterResult: payResult as unknown as Record<string, unknown>,
    };
  }

  // Update path item status
  await supabaseAdmin()
    .from("paylabs_source_path_items")
    .update({ status: "cited" })
    .eq("id", sourcePathItemId);

  return {
    sourcePaymentId: paymentRow.id,
    paymentAdapterResult: payResult as unknown as Record<string, unknown>,
    agentTrace: { payment_executor: { ...(result.ok ? result.meta : {}), payment_id: payResult.paymentId, db_id: paymentRow.id } },
    ...(result.ok ? { llmOutputs: { payment_executor: result.data } } : {}),
    agentCallCounts: { payment_executor: 1 },
  };
}
