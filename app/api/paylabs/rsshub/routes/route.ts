/**
 * GET /api/paylabs/rsshub/routes — list active routes
 * POST /api/paylabs/rsshub/routes — create route (admin)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { isValidFeedUrl } from "@/lib/rsshub/rsshub-client";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_rsshub_routes")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ routes: data ?? [] });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { rsshub_base_url, route_path, title, description, creator_wallet } =
    body as {
      rsshub_base_url?: string;
      route_path?: string;
      title?: string;
      description?: string;
      creator_wallet?: string;
    };

  // Validate required fields
  if (!rsshub_base_url || !route_path || !title || !creator_wallet) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: rsshub_base_url, route_path, title, creator_wallet",
      },
      { status: 400 }
    );
  }

  // Validate URL
  if (!isValidFeedUrl(rsshub_base_url)) {
    return NextResponse.json(
      { error: "rsshub_base_url must be a valid https URL" },
      { status: 400 }
    );
  }

  // Validate route_path starts with /
  if (!route_path.startsWith("/")) {
    return NextResponse.json(
      { error: "route_path must start with /" },
      { status: 400 }
    );
  }

  // Validate creator wallet
  if (!isAddress(creator_wallet)) {
    return NextResponse.json(
      { error: "creator_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  // Validate prices if provided
  const citationPrice =
    typeof body.default_price_per_citation_usdc === "number"
      ? body.default_price_per_citation_usdc
      : 0.000001;
  const unlockPrice =
    typeof body.default_price_per_unlock_usdc === "number"
      ? body.default_price_per_unlock_usdc
      : 0.00001;

  if (citationPrice <= 0 || unlockPrice <= 0) {
    return NextResponse.json(
      { error: "Prices must be positive" },
      { status: 400 }
    );
  }

  const { data, error } = await supabaseAdmin()
    .from("paylabs_rsshub_routes")
    .insert({
      rsshub_base_url,
      route_path,
      title,
      description: description ?? null,
      creator_wallet,
      default_price_per_citation_usdc: citationPrice,
      default_price_per_unlock_usdc: unlockPrice,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Route already exists for this base URL and path" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ route: data }, { status: 201 });
}
