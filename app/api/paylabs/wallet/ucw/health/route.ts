/**
 * GET /api/paylabs/wallet/ucw/health — safe config probe, no secrets.
 */
import { NextResponse } from "next/server";

export async function GET() {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    return NextResponse.json({ ok: true, service: "paylabs-ucw" });
  }

  // Development/test: include config diagnostics
  return NextResponse.json({
    ok: true,
    service: "paylabs-ucw",
    appIdConfigured: !!process.env.NEXT_PUBLIC_CIRCLE_APP_ID,
    googleClientConfigured: !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    circleApiKeyConfigured: !!process.env.CIRCLE_API_KEY,
    supabaseConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    sessionStore: "supabase",
    gatewayEnabled: true,
    arcDomain: 26,
  });
}
