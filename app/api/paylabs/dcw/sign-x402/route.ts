/**
 * POST /api/paylabs/dcw/sign-x402
 *
 * Server-side x402 signing for DCW wallets.
 * Receives a 402 challenge, signs it with the DCW wallet via Circle SDK,
 * and returns the payment signature.
 *
 * Body: { email: string, challenge: object, maxAmountUsdc?: string }
 * Returns: { ok, paymentSignature, paymentMetadata }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createDcwSigner } from "@/lib/paylabs/x402/dcw-signer-adapter";
import { callPaidSeller } from "@/lib/paylabs/x402/buyer-transport";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();
    const sellerUrl = body.sellerUrl as string;
    const maxAmountUsdc = body.maxAmountUsdc || "1.0";

    if (!email || !email.includes("@")) {
      return NextResponse.json(
        { ok: false, error: "Valid email required" },
        { status: 400 }
      );
    }

    if (!sellerUrl) {
      return NextResponse.json(
        { ok: false, error: "sellerUrl required" },
        { status: 400 }
      );
    }

    // 1. Look up DCW wallet for this email
    const { data: wallet, error } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address")
      .eq("email", email)
      .eq("status", "active")
      .limit(1)
      .single();

    if (error || !wallet) {
      return NextResponse.json(
        { ok: false, error: "No DCW wallet found for this email" },
        { status: 404 }
      );
    }

    // 2. Create DCW signer and execute x402 payment
    const dcwSigner = createDcwSigner();

    const result = await callPaidSeller(dcwSigner, {
      sellerUrl,
      method: body.method || "POST",
      body: body.requestBody,
      headers: body.headers || {},
      buyerWalletId: wallet.wallet_id,
      buyerAgentName: "paylabs-dcw-user",
      sellerServiceName: body.serviceName || "discovery",
      maxAmountUsdc,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      data: result.data,
      error: result.error,
      paymentMetadata: result.paymentMetadata,
      freeResponse: result.freeResponse,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/sign-x402] Error:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }
}
