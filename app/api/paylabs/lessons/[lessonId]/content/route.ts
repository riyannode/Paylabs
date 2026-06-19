import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { buildX402Challenge, verifyX402Authorization, buildResourceUrl } from "@/lib/payments/x402";
import { computeSplit } from "@/lib/payments/receipt";
import { submitToGateway } from "@/lib/payments/gateway";
import type { Address } from "viem";

/** Fire-and-forget: swallow errors on non-critical DB writes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fireAndForget(builder: any) {
  void Promise.resolve(builder).catch(() => {});
}

// GET: returns 402 with payment challenge (or full content if already unlocked)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ lessonId: string }> }
) {
  const { lessonId } = await params;
  const userWallet = req.headers.get("x-paylabs-wallet") || "";

  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("*, creator:paylabs_creators(*), source:paylabs_sources(*)")
    .eq("id", lessonId)
    .eq("is_published", true)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  // Check if already unlocked (requires valid wallet address)
  if (userWallet && userWallet.startsWith("0x") && userWallet.length === 42) {
    const { data: unlock } = await supabaseAdmin()
      .from("paylabs_unlocks")
      .select("id")
      .eq("lesson_id", lessonId)
      .eq("user_wallet", userWallet.toLowerCase())
      .single();

    if (unlock) {
      return NextResponse.json({
        status: "unlocked",
        lesson: {
          title: lesson.title,
          body_markdown: lesson.body_markdown,
          content_sha256: lesson.content_sha256,
          source: lesson.source,
        },
      });
    }
  }

  // Return 402 with payment challenge
  const receiverAddress = process.env.X402_RECEIVER_ADDRESS;
  if (!receiverAddress) {
    return NextResponse.json(
      { error: "Server misconfigured: X402_RECEIVER_ADDRESS not set" },
      { status: 500 }
    );
  }

  const challenge = buildX402Challenge(receiverAddress, lesson.price_usdc);
  const resourceUrl = buildResourceUrl(lessonId);

  return NextResponse.json(
    {
      status: "payment_required",
      lesson_id: lessonId,
      price_usdc: lesson.price_usdc,
      resource_url: resourceUrl,
      challenge,
    },
    {
      status: 402,
      headers: {
        "X-PAYMENT-REQUIRED": "true",
        "X-RESOURCE-URL": resourceUrl,
      },
    }
  );
}

// POST: verify signed x402 authorization and unlock lesson
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lessonId: string }> }
) {
  const { lessonId } = await params;
  const body = await req.json();

  const {
    from,      // payer wallet address (0x...)
    to,        // receiver address (0x...)
    value,     // amount in base units (string)
    validAfter,
    validBefore,
    nonce,     // bytes32
    signature, // 65-byte ECDSA signature
  } = body;

  // Validate required fields
  if (!from || !to || !value || !validAfter || !validBefore || !nonce || !signature) {
    return NextResponse.json(
      {
        error: "Missing x402 authorization fields. Required: from, to, value, validAfter, validBefore, nonce, signature",
        required: ["from", "to", "value", "validAfter", "validBefore", "nonce", "signature"],
      },
      { status: 400 }
    );
  }

  // Get lesson
  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("*, creator:paylabs_creators(*)")
    .eq("id", lessonId)
    .eq("is_published", true)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found or not published" }, { status: 404 });
  }

  // Verify creator wallet exists
  if (!lesson.creator?.wallet_address) {
    return NextResponse.json({ error: "Lesson has no verified creator" }, { status: 500 });
  }

  const receiverAddress = process.env.X402_RECEIVER_ADDRESS as Address;
  if (!receiverAddress) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  // Check nonce uniqueness
  const nonceExists = async (nonceHash: string) => {
    const { data } = await supabaseAdmin()
      .from("paylabs_unlocks")
      .select("id")
      .eq("payment_id", nonceHash)
      .single();
    return !!data;
  };

  // Verify x402 authorization
  const result = await verifyX402Authorization(
    { from, to, value, validAfter, validBefore, nonce, signature },
    lesson.price_usdc,
    receiverAddress,
    nonceExists
  );

  if (!result.valid) {
    // Log failed attempt
    fireAndForget(supabaseAdmin().from("paylabs_agent_actions").insert({
      user_wallet: from.toLowerCase(),
      action_type: "x402_verify_failed",
      input_hash: nonce,
      output_hash: "",
      status: "blocked_by_policy",
      policy_decision: { error: result.error },
    }).select("id").single());

    return NextResponse.json({ error: result.error }, { status: 402 });
  }

  const paymentId = result.paymentId!;
  const platformWallet = process.env.PAYLABS_PLATFORM_WALLET!;
  const treasuryWallet = process.env.PAYLABS_TREASURY_WALLET!;
  const split = computeSplit(lesson.price_usdc);
  const resourceUrl = buildResourceUrl(lessonId);

  // Submit signed authorization to Circle Gateway for settlement
  const gatewayResult = await submitToGateway(
    { from, to, value, validAfter, validBefore, nonce, signature },
    value,
    receiverAddress
  );

  if (!gatewayResult.accepted) {
    // Gateway rejected — do NOT create unlock/receipt
    fireAndForget(supabaseAdmin().from("paylabs_agent_actions").insert({
      user_wallet: from.toLowerCase(),
      action_type: "gateway_rejected",
      input_hash: paymentId,
      output_hash: "",
      status: "failed",
      policy_decision: { error: gatewayResult.error, lesson_id: lessonId },
    }).select("id").single());

    return NextResponse.json(
      { error: "Gateway settlement failed", detail: gatewayResult.error },
      { status: 402 }
    );
  }

  // Gateway accepted — now create unlock record
  const { data: unlock, error: unlockErr } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .insert({
      lesson_id: lessonId,
      user_wallet: from.toLowerCase(),
      payment_id: paymentId,
      payment_rail: "x402-gateway",
      amount_usdc: lesson.price_usdc,
      payment_ref: resourceUrl,
      tx_hash: gatewayResult.settlementRef || null,
      gateway_settlement_ref: gatewayResult.settlementRef || null,
    })
    .select("id")
    .single();

  if (unlockErr) {
    return NextResponse.json({ error: unlockErr.message }, { status: 500 });
  }

  // Create payout receipt (only after Gateway accepted)
  await supabaseAdmin().from("paylabs_payout_receipts").insert({
    lesson_id: lessonId,
    unlock_id: unlock.id,
    creator_wallet: lesson.creator.wallet_address.toLowerCase(),
    platform_wallet: platformWallet.toLowerCase(),
    treasury_wallet: treasuryWallet.toLowerCase(),
    gross_amount_usdc: lesson.price_usdc,
    creator_amount_usdc: split.creator,
    platform_amount_usdc: split.platform,
    treasury_amount_usdc: split.treasury,
    payment_ref: resourceUrl,
    tx_hash: gatewayResult.settlementRef || null,
  });

  // Log successful action
  fireAndForget(supabaseAdmin().from("paylabs_agent_actions").insert({
    user_wallet: from.toLowerCase(),
    action_type: "x402_lesson_unlock",
    input_hash: paymentId,
    output_hash: unlock.id,
    status: "completed",
    policy_decision: {
      lesson_id: lessonId,
      amount_usdc: lesson.price_usdc,
      rail: "x402-gateway",
      gateway_ref: gatewayResult.settlementRef,
      batch_id: gatewayResult.batchId,
    },
    payment_id: paymentId,
  }).select("id").single());

  return NextResponse.json({
    status: "unlocked",
    unlock_id: unlock.id,
    payment_id: paymentId,
    settlement_ref: gatewayResult.settlementRef,
    lesson: {
      title: lesson.title,
      body_markdown: lesson.body_markdown,
      content_sha256: lesson.content_sha256,
    },
  });
}
