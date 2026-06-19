import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { computeSplit } from "@/lib/payments/receipt";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { lesson_id, user_wallet } = body;

  if (!lesson_id || !user_wallet) {
    return NextResponse.json({ error: "lesson_id and user_wallet required" }, { status: 400 });
  }

  // Get lesson
  const { data: lesson } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("*, creator:paylabs_creators(*)")
    .eq("id", lesson_id)
    .eq("is_published", true)
    .single();

  if (!lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  // Check not already unlocked
  const { data: existing } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .select("id")
    .eq("lesson_id", lesson_id)
    .eq("user_wallet", user_wallet)
    .single();

  if (existing) {
    return NextResponse.json({ error: "Already unlocked", unlock_id: existing.id }, { status: 409 });
  }

  const payment_id = crypto.randomUUID();
  const payment_ref = `x402-tutor-${Date.now()}`;
  const split = computeSplit(lesson.price_usdc);

  // Create unlock
  const { data: unlock, error: unlockErr } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .insert({
      lesson_id,
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
    lesson_id,
    unlock_id: unlock.id,
    creator_wallet: lesson.creator?.wallet_address || "",
    platform_wallet: process.env.PAYLABS_PLATFORM_WALLET!,
    treasury_wallet: process.env.PAYLABS_TREASURY_WALLET!,
    gross_amount_usdc: lesson.price_usdc,
    creator_amount_usdc: split.creator,
    platform_amount_usdc: split.platform,
    treasury_amount_usdc: split.treasury,
    payment_ref,
  });

  return NextResponse.json({
    status: "unlocked",
    unlock_id: unlock.id,
    payment_id,
    lesson: { title: lesson.title, body_markdown: lesson.body_markdown },
  });
}
