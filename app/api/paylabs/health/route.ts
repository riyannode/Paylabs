import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "paylabs",
    time: new Date().toISOString(),
    x402_gateway_enabled: process.env.X402_GATEWAY_ENABLED === "true",
    runner_configured: !!process.env.ARCLAYER_RUNNER_URL,
  });
}
