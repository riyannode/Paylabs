/**
 * POST /api/paylabs/auth/passkey/authenticate
 *
 * WebAuthn Passkey Authentication for DCW users.
 *
 * Flow:
 *   1. Client calls with email → server generates challenge
 *   2. Client calls navigator.credentials.get() with the challenge
 *   3. Client sends assertion response → server verifies + creates session
 *
 * Body (step 1): { email: string, step: "challenge" }
 * Body (step 2): { email: string, step: "verify", credential: AuthenticationCredential }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createSession, sessionCookieOptions } from "@/lib/paylabs/auth/session";

const RP_ID = process.env.NEXT_PUBLIC_APP_HOST || "localhost";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ ok: false, error: "Valid email required" }, { status: 400 });
    }

    // ── Step 1: Generate authentication challenge ───────────
    if (body.step === "challenge") {
      // Find user's credential
      const { data: user } = await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .select("id, passkey_credential_id")
        .eq("email", email)
        .eq("status", "active")
        .limit(1)
        .single();

      if (!user?.passkey_credential_id) {
        return NextResponse.json(
          { ok: false, error: "No passkey found. Register first." },
          { status: 404 }
        );
      }

      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: [{ id: user.passkey_credential_id }],
        userVerification: "preferred",
      });

      // Store challenge
      await supabaseAdmin().from("paylabs_webauthn_challenges").insert({
        user_id: user.id,
        challenge: options.challenge,
        type: "authentication",
      });

      return NextResponse.json({ ok: true, options });
    }

    // ── Step 2: Verify assertion ────────────────────────────
    if (body.step === "verify") {
      const credential: AuthenticationResponseJSON = body.credential;
      if (!credential?.id) {
        return NextResponse.json({ ok: false, error: "Credential required" }, { status: 400 });
      }

      // Find user by credential ID
      const { data: user } = await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .select("id, email, wallet_id, wallet_address, passkey_credential_id, passkey_public_key, passkey_counter")
        .eq("passkey_credential_id", credential.id)
        .eq("status", "active")
        .limit(1)
        .single();

      if (!user) {
        return NextResponse.json({ ok: false, error: "Unknown credential" }, { status: 404 });
      }

      // Get the stored challenge
      const { data: challengeRow } = await supabaseAdmin()
        .from("paylabs_webauthn_challenges")
        .select("challenge")
        .eq("user_id", user.id)
        .eq("type", "authentication")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!challengeRow) {
        return NextResponse.json({ ok: false, error: "No pending authentication" }, { status: 400 });
      }

      // Verify the assertion
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: process.env.NEXT_PUBLIC_APP_URL || `http://localhost:3000`,
          expectedRPID: RP_ID,
          credential: {
            id: user.passkey_credential_id,
            publicKey: Buffer.from(user.passkey_public_key, "base64"),
            counter: user.passkey_counter,
          },
        });
      } catch (e: unknown) {
        return NextResponse.json(
          { ok: false, error: `Verification failed: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 }
        );
      }

      if (!verification.verified) {
        return NextResponse.json({ ok: false, error: "Authentication not verified" }, { status: 400 });
      }

      // Update counter
      await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .update({ passkey_counter: verification.authenticationInfo.newCounter })
        .eq("id", user.id);

      // Clean up challenge
      await supabaseAdmin()
        .from("paylabs_webauthn_challenges")
        .delete()
        .eq("user_id", user.id)
        .eq("type", "authentication");

      // Create session
      const session = await createSession({
        sub: user.id,
        email: user.email,
        walletId: user.wallet_id || undefined,
        walletAddress: user.wallet_address || undefined,
      });

      const resp = NextResponse.json({
        ok: true,
        userId: user.id,
        email: user.email,
        hasWallet: !!user.wallet_id,
        walletAddress: user.wallet_address || null,
      });

      const cookieOpts = sessionCookieOptions();
      resp.cookies.set(cookieOpts.name, session, {
        httpOnly: cookieOpts.httpOnly,
        secure: cookieOpts.secure,
        sameSite: cookieOpts.sameSite,
        path: cookieOpts.path,
        maxAge: cookieOpts.maxAge,
      });

      return resp;
    }

    return NextResponse.json({ ok: false, error: "Invalid step" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[passkey/authenticate] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
