/**
 * Agent 5: Payment & Receipt Executor Agent
 * Executes purchase only after Policy Guard approval.
 * ALL payment goes through ArcLayer Runner — never Circle/contracts/wallets directly.
 * No fake payment IDs, no fake tx hashes, no DB-only unlocks.
 */

import type { PayLabsTutorStateType } from "./state";
import { executeLessonPurchase } from "@/lib/arclayer-runner/tools";
import { buildResourceUrl } from "@/lib/payments/x402";
import { computeSplit } from "@/lib/payments/receipt";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createHash } from "node:crypto";

export async function paymentReceiptExecutorAgent(
  state: PayLabsTutorStateType
): Promise<Partial<PayLabsTutorStateType>> {
  const { userWallet, lessonId, policyDecision } = state;

  // Gate: only run if policy allowed
  if (!policyDecision?.allowed) {
    return {
      error: "Cannot execute: policy guard did not approve",
      runnerPaymentResult: { ok: false, error: "Policy not approved" },
    };
  }

  if (!lessonId) {
    return {
      error: "lesson_id required",
      runnerPaymentResult: { ok: false, error: "Missing lesson_id" },
    };
  }

  try {
    // Get lesson details
    const { data: lesson } = await supabaseAdmin()
      .from("paylabs_lessons")
      .select("price_usdc, creator:paylabs_creators(wallet_address)")
      .eq("id", lessonId)
      .single();

    if (!lesson) {
      return { error: "Lesson not found", runnerPaymentResult: { ok: false, error: "Lesson not found" } };
    }

    const creator = lesson.creator as unknown as { wallet_address: string } | null;
    const resourceUrl = buildResourceUrl(lessonId);

    // Execute through Runner — NO fallback payment ID
    const result = await executeLessonPurchase(
      userWallet,
      lessonId,
      resourceUrl,
      String(lesson.price_usdc),
      creator?.wallet_address || "",
      {} // signedAuthorization — Runner handles this
    );

    // CRITICAL: Verify Runner returned valid proof
    if (!result.ok) {
      return {
        error: "Runner payment failed",
        runnerPaymentResult: result as unknown as Record<string, unknown>,
      };
    }

    if (!result.paymentId) {
      return {
        error: "Runner returned no paymentId — cannot create unlock",
        runnerPaymentResult: result as unknown as Record<string, unknown>,
      };
    }

    if (!result.paymentRef && !result.settlementRef) {
      return {
        error: "Runner returned no paymentRef or settlementRef — proof incomplete",
        runnerPaymentResult: result as unknown as Record<string, unknown>,
      };
    }

    // Valid proof — create unlock and receipt
    const platformWallet = (process.env.PAYLABS_PLATFORM_WALLET || "").toLowerCase();
    const treasuryWallet = (process.env.PAYLABS_TREASURY_WALLET || "").toLowerCase();
    const split = computeSplit(lesson.price_usdc);

    // Create unlock
    const { data: unlock, error: unlockErr } = await supabaseAdmin()
      .from("paylabs_unlocks")
      .insert({
        lesson_id: lessonId,
        user_wallet: userWallet.toLowerCase(),
        payment_id: result.paymentId, // From Runner only — NO Date.now(), NO fallback
        payment_rail: "x402-gateway",
        amount_usdc: lesson.price_usdc,
        payment_ref: result.paymentRef || result.settlementRef || resourceUrl,
        tx_hash: result.txHash || null,
        gateway_settlement_ref: result.settlementRef || null,
      })
      .select("id")
      .single();

    if (unlockErr) {
      return {
        error: `Failed to create unlock: ${unlockErr.message}`,
        runnerPaymentResult: result as unknown as Record<string, unknown>,
      };
    }

    // Create payout receipt
    const { data: receipt, error: receiptErr } = await supabaseAdmin()
      .from("paylabs_payout_receipts")
      .insert({
        lesson_id: lessonId,
        unlock_id: unlock.id,
        creator_wallet: (creator?.wallet_address || "").toLowerCase(),
        platform_wallet: platformWallet,
        treasury_wallet: treasuryWallet,
        gross_amount_usdc: lesson.price_usdc,
        creator_amount_usdc: split.creator,
        platform_amount_usdc: split.platform,
        treasury_amount_usdc: split.treasury,
        payment_ref: result.paymentRef || result.settlementRef || resourceUrl,
        tx_hash: result.txHash || null,
      })
      .select("id")
      .single();

    if (receiptErr) {
      return {
        error: `Unlock created (${unlock.id}) but receipt failed: ${receiptErr.message}`,
        unlockId: unlock.id,
        runnerPaymentResult: result as unknown as Record<string, unknown>,
      };
    }

    // Update path item status
    const pathId = state.pathId;
    if (pathId) {
      Promise.resolve(supabaseAdmin()
        .from("paylabs_learning_path_items")
        .update({ status: "unlocked" })
        .eq("path_id", pathId)
        .eq("lesson_id", lessonId)
        .then(() => {})).catch(() => {});
    }

    // Log successful action
    Promise.resolve(supabaseAdmin()
      .from("paylabs_agent_actions")
      .insert({
        user_wallet: userWallet.toLowerCase(),
        agent_id: "paylabs-langgraph-v1",
        action_type: "buy_lesson",
        input_hash: createHash("sha256")
          .update(`${lessonId}:${userWallet}`)
          .digest("hex"),
        output_hash: unlock.id,
        status: "completed",
        policy_decision: {
          lesson_id: lessonId,
          path_id: pathId,
          rail: "x402-gateway",
          runner: true,
          payment_id: result.paymentId,
        },
        payment_id: result.paymentId,
      })
      .then(() => {})).catch(() => {});

    return {
      runnerPaymentResult: result as unknown as Record<string, unknown>,
      unlockId: unlock.id,
      receiptId: receipt?.id,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: `Payment execution failed: ${msg}`,
      runnerPaymentResult: { ok: false, error: msg },
    };
  }
}
