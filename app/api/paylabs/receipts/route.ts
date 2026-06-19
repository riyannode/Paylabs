import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_payout_receipts")
    .select("*, lesson:paylabs_lessons(title, source:paylabs_sources(source_title, canonical_url))")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ receipts: data });
}
