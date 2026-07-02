import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/paylabs/db/server";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  const { data: payments, error } = await supabaseAdmin()
    .from("paylabs_source_payments")
    .select("*")
    .eq("creator_wallet", wallet.toLowerCase())
    .eq("status", "completed")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const total = (payments || []).reduce((s, r) => s + Number(r.amount_usdc), 0);

  return NextResponse.json({
    earnings: {
      total_creator_usdc: total,
      payment_count: payments?.length || 0,
      payments: (payments || []).map((p) => ({
        id: p.id,
        source_title: p.source_title,
        source_url: p.source_url,
        amount_usdc: Number(p.amount_usdc),
        payment_kind: p.payment_kind,
        payment_ref: p.payment_ref,
        created_at: p.created_at,
      })),
    },
  });
}
