// POST /api/paylabs/agent/buy-lesson
// Agent-triggered lesson purchase through ArcLayer Runner.
// Enforces budget policy before calling Runner.
// All privileged payment goes through Runner — no direct Circle/contract calls.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { computeSplit } from "@/lib/payments/receipt";
import { executeLessonPurchase, isRunnerAvailable } from "@/lib/arclayer-runner/tools";
import { buildResourceUrl } from "@/lib/payments/x402";
import { createHash } from "node:crypto";

/** Fire-and-forget: swallow errors on non-critical DB writes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fireAndForget(builder: any) {
  void Promise.resolve(builder).catch(() => {});
}

const MAX_LESSON_PRICE_USDC = Number(process.env.PAYLABS_MAX_LESSON_PRICE_USDC || "0.05");

interface PolicyCheck {
  passed: boolean;
  reason?: string;
}

async function enforceBudgetPolicy(
  userWallet: string,
  lessonId: string,
  pathId?: string
): Promise<PolicyCheck> {
  // 1. If pathId provided, verify path exists and belongs to user
  if (pathId) {
    const { data: path } = await supabaseAdmin()
      .from("paylabs_learning_paths")
      .select("id, status, budget_usdc, estimated_total_usdc")
      .eq("id", pathId)
      .eq("user_wallet", userWallet.toLowerCase())
      .single();

    if (!path) {
      return { passed: false, reason: "Learning path not found or not owned by user" };
    }
    if (path.status !== "approved" && path.status !== "active") {
      return { passed: false, reason: `Path status is '${path.status}', must be 'approved' or 'active'` };
    }

    // Verify lesson is in the path
    const { data: pathItem } = await supabaseAdmin()
      .from("paylabs_learning_path_items")
      .select("id")
      .eq("path_id", pathId)
      .eq("lesson_id", lessonId)
      .single();

    if (!pathItem) {
      return { passed: false, reason: "Lesson is not in the approved learning path" };
    }
  }

  // 2. Get lesson
  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("id, price_usdc, is_published, source_id, content_sha256, creator_id, creator:paylabs_creators(wallet_address, is_verified)")
    .eq("id", lessonId)
    .single();

  if (!lesson) {
    return { passed: false, reason: "Lesson not found" };
  }
  if (!lesson.is_published) {
    return { passed: false, reason: "Lesson is not published" };
  }

  // 3. Source validation
  if (!lesson.source_id) {
    return { passed: false, reason: "Lesson has no source" };
  }
  const { data: source } = await supabaseAdmin()
    .from("paylabs_sources")
    .select("normalized_sha256")
    .eq("id", lesson.source_id)
    .single();
  if (!source?.normalized_sha256) {
    return { passed: false, reason: "Lesson source has no content hash" };
  }

  // 4. Content hash validation
  if (!lesson.content_sha256) {
    return { passed: false, reason: "Lesson has no content hash" };
  }

  // 5. Creator validation
  const creator = lesson.creator as unknown as { wallet_address: string; is_verified: boolean } | null;
  if (!creator?.wallet_address) {
    return { passed: false, reason: "Lesson has no creator wallet" };
  }
  if (!creator.is_verified) {
    return { passed: false, reason: "Creator wallet is not verified" };
  }

  // 6. Price limits
  if (lesson.price_usdc > MAX_LESSON_PRICE_USDC) {
    return { passed: false, reason: `Lesson price ${lesson.price_usdc} exceeds max ${MAX_LESSON_PRICE_USDC}` };
  }

  // 7. Already unlocked?
  const { data: existing } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .select("id")
    .eq("lesson_id", lessonId)
    .eq("user_wallet", userWallet.toLowerCase())
    .single();

  if (existing) {
    return { passed: false, reason: "Lesson already unlocked by this user" };
  }

  // 8. Budget check (if path provided)
  if (pathId) {
    const { data: path } = await supabaseAdmin()
      .from("paylabs_learning_paths")
      .select("budget_usdc")
      .eq("id", pathId)
      .single();

    if (path) {
      // Sum already-spent amount for this path
      const { data: pathItems } = await supabaseAdmin()
        .from("paylabs_learning_path_items")
        .select("lesson_id, status")
        .eq("path_id", pathId);

      const unlockedLessonIds = (pathItems || [])
        .filter((pi) => pi.status === "completed" || pi.status === "unlocked")
        .map((pi) => pi.lesson_id);

      if (unlockedLessonIds.length > 0) {
        const { data: unlockedLessons } = await supabaseAdmin()
          .from("paylabs_lessons")
          .select("price_usdc")
          .in("id", unlockedLessonIds);

        const spent = (unlockedLessons || []).reduce(
          (sum, l) => sum + Number(l.price_usdc),
          0
        );
        const remaining = Number(path.budget_usdc) - spent;

        if (lesson.price_usdc > remaining) {
          return {
            passed: false,
            reason: `Insufficient budget: need ${lesson.price_usdc} USDC, ${remaining.toFixed(6)} remaining`,
          };
        }
      }
    }
  }

  return { passed: true };
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { user_wallet, lesson_id, path_id, signed_authorization } = body;

  // Validate inputs
  if (!user_wallet || !lesson_id || !path_id) {
    return NextResponse.json(
      { error: "user_wallet, lesson_id, and path_id all required. Agent must not buy without approved path." },
      { status: 400 }
    );
  }
  if (!user_wallet.startsWith("0x") || user_wallet.length !== 42) {
    return NextResponse.json(
      { error: "user_wallet must be a valid EVM address (0x...)" },
      { status: 400 }
    );
  }

  // Enforce budget policy
  const policy = await enforceBudgetPolicy(user_wallet, lesson_id, path_id);
  if (!policy.passed) {
    // Log blocked action
    fireAndForget(supabaseAdmin().from("paylabs_agent_actions").insert({
      user_wallet: user_wallet.toLowerCase(),
      action_type: "buy_lesson",
      input_hash: createHash("sha256").update(`${lesson_id}:${user_wallet}`).digest("hex"),
      output_hash: "",
      status: "blocked_by_policy",
      policy_decision: { reason: policy.reason, lesson_id, path_id },
    }).select("id").single());

    return NextResponse.json(
      { error: "Policy check failed", reason: policy.reason },
      { status: 403 }
    );
  }

  // Check Runner availability
  const runnerOk = await isRunnerAvailable();
  if (!runnerOk) {
    return NextResponse.json(
      { error: "ArcLayer Runner is not available. Set ARCLAYER_RUNNER_URL and ARCLAYER_RUNNER_API_KEY." },
      { status: 503 }
    );
  }

  // Get lesson details for Runner call
  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("price_usdc, creator:paylabs_creators(wallet_address)")
    .eq("id", lesson_id)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  const creator = lesson.creator as unknown as { wallet_address: string } | null;
  const resourceUrl = buildResourceUrl(lesson_id);

  // If signed_authorization provided, use it. Otherwise Runner will initiate.
  const auth = signed_authorization || {};

  try {
    // Execute through Runner
    const result = await executeLessonPurchase(
      user_wallet,
      lesson_id,
      resourceUrl,
      String(lesson.price_usdc),
      creator?.wallet_address || "",
      auth
    );

    // Create unlock record
    const platformWallet = process.env.PAYLABS_PLATFORM_WALLET!;
    const treasuryWallet = process.env.PAYLABS_TREASURY_WALLET!;
    const split = computeSplit(lesson.price_usdc);

    const { data: unlock, error: unlockErr } = await supabaseAdmin()
      .from("paylabs_unlocks")
      .insert({
        lesson_id,
        user_wallet: user_wallet.toLowerCase(),
        payment_id: result.paymentId || `runner-${Date.now()}`,
        payment_rail: "x402-gateway",
        amount_usdc: lesson.price_usdc,
        payment_ref: resourceUrl,
        tx_hash: result.txHash || null,
        gateway_settlement_ref: result.settlementRef || null,
      })
      .select("id")
      .single();

    if (unlockErr) {
      return NextResponse.json({ error: unlockErr.message }, { status: 500 });
    }

    // Create payout receipt
    await supabaseAdmin().from("paylabs_payout_receipts").insert({
      lesson_id,
      unlock_id: unlock.id,
      creator_wallet: (creator?.wallet_address || "").toLowerCase(),
      platform_wallet: platformWallet.toLowerCase(),
      treasury_wallet: treasuryWallet.toLowerCase(),
      gross_amount_usdc: lesson.price_usdc,
      creator_amount_usdc: split.creator,
      platform_amount_usdc: split.platform,
      treasury_amount_usdc: split.treasury,
      payment_ref: resourceUrl,
      tx_hash: result.txHash || null,
    });

    // Update path item status if path_id provided
    if (path_id) {
      fireAndForget(supabaseAdmin()
        .from("paylabs_learning_path_items")
        .update({ status: "unlocked" })
        .eq("path_id", path_id)
        .eq("lesson_id", lesson_id)
        .select("id")
        .single());
    }

    // Log successful action
    fireAndForget(supabaseAdmin().from("paylabs_agent_actions").insert({
      user_wallet: user_wallet.toLowerCase(),
      agent_id: "paylabs-tutor",
      action_type: "buy_lesson",
      input_hash: createHash("sha256").update(`${lesson_id}:${user_wallet}`).digest("hex"),
      output_hash: unlock.id,
      status: "completed",
      policy_decision: { lesson_id, path_id, rail: "x402-gateway", runner: true },
      payment_id: result.paymentId,
    }).select("id").single());

    return NextResponse.json({
      status: "unlocked",
      unlock_id: unlock.id,
      payment_id: result.paymentId,
      settlement_ref: result.settlementRef,
      tx_hash: result.txHash,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
