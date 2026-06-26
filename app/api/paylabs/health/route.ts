import { NextResponse } from "next/server";
import { TIER_SERVICE_PRESETS } from "@/lib/paylabs/delegated-runtime/quote-engine";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "paylabs",
    time: new Date().toISOString(),
    x402_gateway_enabled: process.env.X402_GATEWAY_ENABLED === "true",
    payment_executor_configured: !!process.env.PAYLABS_PAYMENT_EXECUTOR_URL,
    _diag_easy_services: TIER_SERVICE_PRESETS.easy,
  });
}
