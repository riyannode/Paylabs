import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { buildX402Challenge } from "@/lib/payments/x402";
import { computeSplit } from "@/lib/payments/receipt";
import { createHash } from "node:crypto";

// GET: returns 402 with payment challenge (or full content if already unlocked)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ lessonId: string }> }
) {
  const { lessonId } = await params;
  const userWallet = req.headers.get("x-paylabs-wallet") || "";

  // Get lesson
  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("*, creator:paylabs_creators(*), source:paylabs_sources(*)")
    .eq("id", lessonId)
    .eq("is_published", true)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  // Check if already unlocked
  if (userWallet) {
    const { data: unlock } = await supabaseAdmin()
      .from("paylabs_unlocks")
      .select("id")
      .eq("lesson_id", lessonId)
      .eq("user_wallet", userWallet)
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
  const receiverAddress = process.env.X402_RECEIVER_ADDRESS || "";
  const challenge = buildX402Challenge(receiverAddress, lesson.price_usdc);

  return NextResponse.json(
    {
      status: "payment_required",
      lesson_id: lessonId,
      price_usdc: lesson.price_usdc,
      challenge,
    },
    { status: 402 }
  );
}

// POST: process payment and unlock lesson
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lessonId: string }> }
) {
  const { lessonId } = await params;
  const body = await req.json();
  const { user_wallet, payment_id, payment_ref, amount_usdc } = body;

  if (!user_wallet || !payment_id || !payment_ref) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
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

  // Reject duplicate payment
  const { data: existing } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .select("id")
    .eq("payment_id", payment_id)
    .single();

  if (existing) {
    return NextResponse.json({ error: "Duplicate payment_id" }, { status: 409 });
  }

  // Verify amount
  if (Number(amount_usdc) !== Number(lesson.price_usdc)) {
    return NextResponse.json({ error: "Amount mismatch" }, { status: 400 });
  }

  const platformWallet = process.env.PAYLABS_PLATFORM_WALLET!;
  const treasuryWallet = process.env.PAYLABS_TREASURY_WALLET!;
  const split = computeSplit(lesson.price_usdc);

  // Create unlock
  const { data: unlock, error: unlockErr } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .insert({
      lesson_id: lessonId,
      user_wallet,
      payment_id,
      payment_rail: "x402-gateway",
      amount_usdc: lesson.price_usdc,
      payment_ref,
    })
    .select("id")
    .single();

  if (unlockErr) {
    return NextResponse.json({ error: unlockErr.message }, { status: 500 });
  }

  // Create payout receipt
  await supabaseAdmin().from("paylabs_payout_receipts").insert({
    lesson_id: lessonId,
    unlock_id: unlock.id,
    creator_wallet: lesson.creator?.wallet_address || "",
    platform_wallet: platformWallet,
    treasury_wallet: treasuryWallet,
    gross_amount_usdc: lesson.price_usdc,
    creator_amount_usdc: split.creator,
    platform_amount_usdc: split.platform,
    treasury_amount_usdc: split.treasury,
    payment_ref,
  });

  return NextResponse.json({
    status: "unlocked",
    unlock_id: unlock.id,
    lesson: {
      title: lesson.title,
      body_markdown: lesson.body_markdown,
      content_sha256: lesson.content_sha256,
    },
  });
}
