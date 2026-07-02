/**
 * POST /api/paylabs/auth/google
 *
 * Google Sign-In for DCW users.
 * Receives a Google ID token from the frontend, verifies it,
 * and creates a DCW session (same as passkey/OTP flow).
 *
 * Security:
 *   - Verifies ID token via Google's tokeninfo endpoint
 *   - Only accepts tokens with matching audience (CLIENT_ID)
 *   - Finds or creates user in paylabs_dcw_wallets
 *   - Creates JWT session (same as OTP/passkey)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createSession, sessionCookieOptions } from "@/lib/paylabs/auth/session";

import { getSession as getUcwSession } from "@/lib/paylabs/ucw";
import { randomUUID } from "node:crypto";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";


async function rejectIfCreatorWalletActive(req: NextRequest) {
  const ucwSid = req.cookies.get("ucw_sid")?.value;
  if (!ucwSid) return null;

  const ucwSession = await getUcwSession(ucwSid);
  if (!ucwSession?.walletAddress) return null;

  return NextResponse.json(
    {
      ok: false,
      error: "Creator Wallet is already connected. Disconnect it before connecting PayLabs Payment Wallet.",
      activeWalletMode: "ucw",
    },
    { status: 409 },
  );
}

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();

    if (!idToken || typeof idToken !== "string") {
      return NextResponse.json(
        { ok: false, error: "Google ID token required" },
        { status: 400 },
      );
    }

    // ── Verify Google ID token ────────────────────────────────
    const tokenInfo = await verifyGoogleToken(idToken);
    if (!tokenInfo) {
      return NextResponse.json(
        { ok: false, error: "Invalid Google token" },
        { status: 401 },
      );
    }

    const email = tokenInfo.email?.toLowerCase().trim();
    if (!email || !email.includes("@")) {
      return NextResponse.json(
        { ok: false, error: "Google account must have an email" },
        { status: 400 },
      );
    }

    // ── Find or create user ───────────────────────────────────
    let userId: string;
    let walletId: string | undefined;
    let walletAddress: string | undefined;

    const { data: existing } = await supabaseAdmin()
      .from("paylabs_dcw_wallets")
      .select("id, wallet_id, wallet_address")
      .eq("email", email)
      .limit(1)
      .single();

    if (existing) {
      userId = existing.id;
      walletId = existing.wallet_id || undefined;
      walletAddress = existing.wallet_address || undefined;
    } else {
      // New user — insert row (wallet will be created later)
      userId = randomUUID();
      await supabaseAdmin().from("paylabs_dcw_wallets").insert({
        id: userId,
        email,
        wallet_id: null,
        wallet_address: null,
        display_name: tokenInfo.name || email.split("@")[0],
        status: "active",
      });
    }

    // ── Create session ────────────────────────────────────────
    const walletModeConflict = await rejectIfCreatorWalletActive(req);
    if (walletModeConflict) return walletModeConflict;

    const session = await createSession({
      sub: userId,
      email,
      walletId,
      walletAddress,
    });

    const cookieOpts = sessionCookieOptions();
    const resp = NextResponse.json({
      ok: true,
      userId,
      email,
      hasWallet: !!walletId,
      walletAddress: walletAddress || null,
      displayName: tokenInfo.name || email.split("@")[0],
      avatarUrl: tokenInfo.picture || null,
    });
    resp.cookies.set(cookieOpts.name, session, {
      httpOnly: cookieOpts.httpOnly,
      secure: cookieOpts.secure,
      sameSite: cookieOpts.sameSite,
      path: cookieOpts.path,
      maxAge: cookieOpts.maxAge,
    });

    return resp;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auth/google] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * Verify a Google ID token using Google's tokeninfo endpoint.
 * Returns null if invalid.
 */
async function verifyGoogleToken(idToken: string): Promise<{
  email?: string;
  name?: string;
  picture?: string;
  sub?: string;
} | null> {
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(5_000) },
    );

    if (!resp.ok) return null;

    const data = await resp.json();

    // Verify audience matches our client ID
    if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) {
      console.warn("[auth/google] audience mismatch", {
        expected: GOOGLE_CLIENT_ID,
        got: data.aud,
      });
      return null;
    }

    // Verify email is verified
    if (data.email_verified !== "true" && data.email_verified !== true) {
      return null;
    }

    return {
      email: data.email,
      name: data.name,
      picture: data.picture,
      sub: data.sub,
    };
  } catch (e) {
    console.error("[auth/google] token verification failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
