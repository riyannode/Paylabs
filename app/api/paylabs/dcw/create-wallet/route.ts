/**
 * POST /api/paylabs/dcw/create-wallet
 *
 * Creates DCW wallet for the authenticated session user.
 * REQUIRES valid session cookie (passkey auth).
 *
 * No body required — user identity comes from session.
 * Returns: { walletId, address, chain, isNew }
 */

import { NextRequest, NextResponse } from "next/server";
import { createRequire } from "node:module";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getSession } from "@/lib/paylabs/auth/session";

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
  _dcwClient = mod.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  return _dcwClient;
}

// ─── Wallet Set ──────────────────────────────────────────────

const WALLET_SET_NAME = "PayLabs-DCW-Global";
let _walletSetId: string | null = null;

async function getOrCreateWalletSetId(): Promise<string> {
  if (_walletSetId) return _walletSetId;
  const client = getDcwClient();
  try {
    const listResp = await client.getWalletSets();
    const sets = listResp?.data?.walletSets || [];
    const existing = sets.find((s: any) => s.name === WALLET_SET_NAME);
    if (existing) { _walletSetId = existing.id; return _walletSetId!; }
  } catch {}
  const createResp = await client.createWalletSet({ name: WALLET_SET_NAME });
  _walletSetId = createResp?.data?.walletSet?.id;
  if (!_walletSetId) throw new Error("Failed to create wallet set");
  return _walletSetId;
}

// ─── Handler ─────────────────────────────────────────────────

export async function POST(_req: NextRequest) {
  try {
    // 1. Auth required — session identity, not email from body
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
    }

    const userId = session.sub;
    const email = session.email;

    // 2. Check if wallet already exists
    const { data: existing } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("wallet_id, wallet_address, chain")
      .eq("id", userId)
      .not("wallet_id", "eq", "")
      .limit(1)
      .single();

    if (existing?.wallet_id) {
      return NextResponse.json({
        ok: true,
        walletId: existing.wallet_id,
        address: existing.wallet_address,
        chain: existing.chain,
        isNew: false,
      });
    }

    // 3. Create DCW wallet via Circle SDK
    const client = getDcwClient();
    const walletSetId = await getOrCreateWalletSetId();

    const createResp = await client.createWallets({
      accountType: "EOA",
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId,
    });

    const wallet = createResp?.data?.wallets?.[0];
    if (!wallet?.id || !wallet?.address) {
      console.error("[dcw/create-wallet] Circle SDK returned no wallet:", JSON.stringify(createResp?.data));
      return NextResponse.json({ ok: false, error: "Circle SDK failed to create wallet" }, { status: 502 });
    }

    // 4. Upsert in Supabase (user row may exist from passkey registration with empty wallet_id)
    const { error: upsertError } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .upsert({
        id: userId,
        email,
        wallet_id: wallet.id,
        wallet_address: wallet.address.toLowerCase(),
        wallet_set_id: walletSetId,
        chain: "ARC-TESTNET",
        account_type: "EOA",
        status: "active",
      }, { onConflict: "id" });

    if (upsertError) {
      console.error("[dcw/create-wallet] Supabase upsert error:", upsertError);
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
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
