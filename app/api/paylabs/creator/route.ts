import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  const { data: receipts, error } = await supabaseAdmin()
    .from("paylabs_payout_receipts")
    .select("*, lesson:paylabs_lessons(title)")
    .eq("creator_wallet", wallet)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const total = (receipts || []).reduce((s, r) => s + Number(r.creator_amount_usdc), 0);

  return NextResponse.json({
    earnings: {
      total_creator_usdc: total,
      receipt_count: receipts?.length || 0,
      receipts: (receipts || []).map((r) => ({
        id: r.id,
        lesson_title: r.lesson?.title,
        gross_amount_usdc: Number(r.gross_amount_usdc),
        creator_amount_usdc: Number(r.creator_amount_usdc),
        platform_amount_usdc: Number(r.platform_amount_usdc),
        treasury_amount_usdc: Number(r.treasury_amount_usdc),
        payment_ref: r.payment_ref,
        created_at: r.created_at,
      })),
    },
  });
}
