import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_lessons")
    .select("id, slug, title, summary, price_usdc, difficulty, tags, estimated_minutes, creator:paylabs_creators(display_name, wallet_address), source:paylabs_sources(source_title, canonical_url, normalized_sha256)")
    .eq("is_published", true)
    .order("price_usdc", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ lessons: data });
}
