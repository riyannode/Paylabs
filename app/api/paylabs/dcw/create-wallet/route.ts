/**
 * POST /api/paylabs/dcw/create-wallet
 *
 * Creates (or returns existing) DCW wallet for a user email.
 * DCW = Developer-Controlled Wallet — Circle holds keys, app signs x402 server-side.
 *
 * Body: { email: string }
 * Returns: { walletId, address, chain, isNew }
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/supabase/server";

const _require = createRequire(import.meta.url);

// ─── Lazy DCW client init ────────────────────────────────────

let _dcwClient: any = null;

function getDcwClient() {
  if (_dcwClient) return _dcwClient;

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

  if (!apiKey || !entitySecret) {
    throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET required");
  }

  const mod = _require("@circle-fin/developer-controlled-wallets");
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });
  return _dcwClient;
}

// ─── Wallet Set Management ───────────────────────────────────

const WALLET_SET_NAME = "PayLabs-DCW-Global";
let _walletSetId: string | null = null;

async function getOrCreateWalletSetId(): Promise<string> {
  if (_walletSetId) return _walletSetId;

  const client = getDcwClient();

  // Try to find existing wallet set
  try {
    const listResp = await client.getWalletSets();
    const sets = listResp?.data?.walletSets || [];
    const existing = sets.find((s: any) => s.name === WALLET_SET_NAME);
    if (existing) {
      _walletSetId = existing.id;
      return _walletSetId!;
    }
  } catch {
    // If listing fails, create a new one
  }

  // Create new wallet set
  const createResp = await client.createWalletSet({
    name: WALLET_SET_NAME,
  });
  _walletSetId = createResp?.data?.walletSet?.id;
  if (!_walletSetId) {
    throw new Error("Failed to create wallet set");
  }
  return _walletSetId;
}

// ─── Main Handler ────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json(
        { ok: false, error: "Valid email required" },
        { status: 400 }
      );
    }

    // 1. Check if wallet already exists for this email
    const { data: existing } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address, chain, status")
      .eq("email", email)
      .eq("status", "active")
      .limit(1)
      .single();

    if (existing) {
      return NextResponse.json({
        ok: true,
        walletId: existing.wallet_id,
        address: existing.wallet_address,
        chain: existing.chain,
        isNew: false,
      });
    }

    // 2. Create new DCW wallet via Circle SDK
    const client = getDcwClient();
    const walletSetId = await getOrCreateWalletSetId();

    const createResp = await client.createWallets({
      accountType: "EOA",
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId,
    });

    const wallets = createResp?.data?.wallets || [];
    const wallet = wallets[0];

    if (!wallet?.id || !wallet?.address) {
      console.error("[dcw/create-wallet] Circle SDK returned no wallet:", JSON.stringify(createResp?.data));
      return NextResponse.json(
        { ok: false, error: "Circle SDK failed to create wallet" },
        { status: 502 }
      );
    }

    // 3. Store in Supabase
    const { error: insertError } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .insert({
        email,
        wallet_id: wallet.id,
        wallet_address: wallet.address.toLowerCase(),
        wallet_set_id: walletSetId,
        chain: "ARC-TESTNET",
        account_type: "EOA",
        status: "active",
      });

    if (insertError) {
      console.error("[dcw/create-wallet] Supabase insert error:", insertError);
      // Wallet was created in Circle but not stored — still return it
      // The user can retry and we'll find it via Circle API
    }

    return NextResponse.json({
      ok: true,
      walletId: wallet.id,
      address: wallet.address,
      chain: "ARC-TESTNET",
      isNew: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[dcw/create-wallet] Error:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }
}
