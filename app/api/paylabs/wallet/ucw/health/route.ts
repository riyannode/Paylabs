/**
 * GET /api/paylabs/wallet/ucw/health — safe config probe, no secrets.
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    appIdConfigured: !!process.env.NEXT_PUBLIC_CIRCLE_APP_ID,
    googleClientConfigured: !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    circleApiKeyConfigured: !!process.env.CIRCLE_API_KEY,
    supabaseConfigured: !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    sessionStore: "supabase",
    gatewayEnabled: true,
    arcDomain: 26,
  });
}
