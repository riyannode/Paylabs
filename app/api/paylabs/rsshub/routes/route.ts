/**
 * GET /api/paylabs/rsshub/routes — list active routes
 * POST /api/paylabs/rsshub/routes — create route (admin, Bearer auth required)
 *
 * Phase 1: creator_wallet now optional (nullable for unverified routes).
 * is_monetized defaults to false; only set true after verification.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { isValidFeedUrl } from "@/lib/rsshub/rsshub-client";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

function requireRsshubAdmin(req: NextRequest): NextResponse | null {
  const adminSecret =
    process.env.PAYLABS_RSSHUB_ADMIN_SECRET ||
    process.env.PAYLABS_RSSHUB_SYNC_SECRET;
  if (!adminSecret) {
    return NextResponse.json(
      { error: "RSSHub admin not configured" },
      { status: 503 }
    );
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== adminSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

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
  const authError = requireRsshubAdmin(req);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    rsshub_base_url,
    route_path,
    title,
    description,
    creator_wallet,
    is_monetized,
  } = body as {
    rsshub_base_url?: string;
    route_path?: string;
    title?: string;
    description?: string;
    creator_wallet?: string;
    is_monetized?: boolean;
  };

  // Validate required fields (creator_wallet now optional)
  if (!rsshub_base_url || !route_path || !title) {
    return NextResponse.json(
      {
        error:
          "Missing required fields: rsshub_base_url, route_path, title",
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

  // Validate creator wallet if provided
  if (creator_wallet && !isAddress(creator_wallet)) {
    return NextResponse.json(
      { error: "creator_wallet must be a valid EVM address" },
      { status: 400 }
    );
  }

  // Validate prices if provided
  const citationPrice =
    typeof body.default_price_per_citation_usdc === "number"
      ? body.default_price_per_citation_usdc
      : 0;
  const unlockPrice =
    typeof body.default_price_per_unlock_usdc === "number"
      ? body.default_price_per_unlock_usdc
      : 0;

  // If monetized, require wallet + positive prices
  const shouldBeMonetized = is_monetized === true;
  if (shouldBeMonetized && !creator_wallet) {
    return NextResponse.json(
      { error: "creator_wallet required when is_monetized=true" },
      { status: 400 }
    );
  }
  if (shouldBeMonetized && (citationPrice <= 0 || unlockPrice <= 0)) {
    return NextResponse.json(
      { error: "Prices must be positive when is_monetized=true" },
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
      creator_wallet: creator_wallet || null,
      is_monetized: shouldBeMonetized,
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
