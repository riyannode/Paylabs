import { NextResponse } from "next/server";
import { SERVER_MAX_BUDGET_USDC } from "@/lib/paylabs/public-api/security";

export async function GET() {
  return NextResponse.json({ service: "PayLabs Public Research API", api_version: "v1", endpoint: "/api/x402/v1/research", method: "POST", network: "arc-testnet", network_id: "eip155:5042002", asset: { symbol: "USDC", address: "0x3600000000000000000000000000000000000000", decimals: 6 }, supported_route_tiers: ["auto", "easy", "normal", "advanced"], maximum_budget_usdc: SERVER_MAX_BUDGET_USDC, request_schema: { goal: "string", route_tier: "auto|easy|normal|advanced", max_budget_usdc: "string|number", response_mode: "compact|full", client_request_id: "string" }, response_schema: { ok: "boolean", status: "completed|failed|payment_required", run_id: "uuid", result: "PublicResearchResult", route: "object", cost: "object", payment: "object", receipt: "object" }, receipt_endpoints: ["/api/x402/v1/runs/{runId}", "/api/x402/v1/runs/{runId}/receipt", "/api/x402/v1/runs/{runId}/payments"], openapi: "/api/x402/v1/openapi.json" });
}
