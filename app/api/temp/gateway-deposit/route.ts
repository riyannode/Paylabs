// POST /api/temp/gateway-deposit — approve + deposit USDC to Gateway
import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = _require("@circle-fin/developer-controlled-wallets");

const USDC_ARC = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const DEPOSIT_AMOUNT = "100000"; // 0.1 USDC

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("Missing Circle creds");
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function POST(req: NextRequest) {
  let body: { walletId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const walletId = body.walletId;
  if (!walletId) return NextResponse.json({ ok: false, error: "Provide single walletId" }, { status: 400 });

  try {
    const client = getClient();

    // Log full request params for debugging
    const params = {
      walletId,
      contractAddress: USDC_ARC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [GATEWAY_WALLET, DEPOSIT_AMOUNT],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: `dep-${walletId.slice(0, 8)}-${Date.now()}`,
    };
    console.log("[deposit] approve params:", JSON.stringify(params, null, 2));

    const resp = await client.createContractExecutionTransaction(params);
    return NextResponse.json({ ok: true, step: "approve", data: resp.data });
  } catch (e: any) {
    // Log full error for debugging
    const errDetail = {
      message: e.message,
      code: e.code,
      status: e.status,
      response: e.response?.data,
      requestBody: e.config?.data,
      requestUrl: e.config?.url,
      headers: e.config?.headers,
    };
    console.error("[deposit] approve error:", JSON.stringify(errDetail, null, 2));
    return NextResponse.json({ ok: false, step: "approve", error: errDetail });
  }
}
