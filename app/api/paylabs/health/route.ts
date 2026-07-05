import { NextResponse } from "next/server";

export async function GET() {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    return NextResponse.json({ ok: true, service: "paylabs" });
  }

  // Development/test: include diagnostics
  const { TIER_SERVICE_PRESETS } = await import("@/lib/paylabs/delegated-runtime/quote-engine");
  return NextResponse.json({
    ok: true,
    service: "paylabs",
    time: new Date().toISOString(),
    x402_gateway_enabled: process.env.X402_GATEWAY_ENABLED === "true",
    payment_executor_configured: !!process.env.PAYLABS_PAYMENT_EXECUTOR_URL,
    _diag_easy_services: TIER_SERVICE_PRESETS.easy,
  });
}
