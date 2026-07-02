/**
 * POST /api/paylabs/auth/passkey/register
 *
 * WebAuthn Passkey Registration for DCW users.
 *
 * Flow:
 *   1. Client calls with email → server generates challenge
 *   2. Client calls navigator.credentials.create() with the challenge
 *   3. Client sends attestation response → server verifies + stores credential
 *   4. Server creates JWT session + sets cookie
 *
 * Body (step 1): { email: string, step: "challenge" }
 * Body (step 2): { email: string, step: "verify", credential: RegistrationCredential }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createSession, sessionCookieOptions } from "@/lib/paylabs/auth/session";

import { getSession as getUcwSession } from "@/lib/paylabs/ucw";
import { randomUUID } from "node:crypto";

const RP_NAME = "PayLabs";
function getRpId(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_HOST || req.nextUrl.hostname || "localhost";
}
function getExpectedOrigin(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin || "http://localhost:3000";
}


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
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ ok: false, error: "Valid email required" }, { status: 400 });
    }

    // ── Step 1: Generate challenge ──────────────────────────
    if (body.step === "challenge") {
      // Find or create user ID for this email
      let userId: string;
      const { data: existing } = await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .select("id, passkey_credential_id")
        .eq("email", email)
        .limit(1)
        .single();

      if (existing?.passkey_credential_id) {
        return NextResponse.json(
          { ok: false, error: "Passkey already registered. Use login instead." },
          { status: 409 }
        );
      }

      userId = existing?.id || randomUUID();

      // Generate WebAuthn registration options
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: getRpId(req),
        userID: Buffer.from(userId),
        userName: email,
        userDisplayName: email.split("@")[0],
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
      });

      // Store challenge for verification
      await supabaseAdmin().from("paylabs_webauthn_challenges").insert({
        user_id: userId,
        email,
        challenge: options.challenge,
        type: "registration",
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });

      return NextResponse.json({ ok: true, options });
    }

    // ── Step 2: Verify attestation ──────────────────────────
    if (body.step === "verify") {
      const credential: RegistrationResponseJSON = body.credential;
      if (!credential?.id) {
        return NextResponse.json({ ok: false, error: "Credential required" }, { status: 400 });
      }

      // Find the challenge
      const { data: challengeRow } = await supabaseAdmin()
        .from("paylabs_webauthn_challenges")
        .select("user_id, challenge")
        .eq("email", email)
        .eq("type", "registration")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!challengeRow) {
        return NextResponse.json({ ok: false, error: "No pending registration" }, { status: 400 });
      }

      // Verify the attestation
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: credential,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: getExpectedOrigin(req),
          expectedRPID: getRpId(req),
        });
      } catch (e: unknown) {
        return NextResponse.json(
          { ok: false, error: `Verification failed: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 }
        );
      }

      if (!verification.verified || !verification.registrationInfo) {
        return NextResponse.json({ ok: false, error: "Registration not verified" }, { status: 400 });
      }

      const { credential: regCredential } = verification.registrationInfo;
      const publicKey = Buffer.from(regCredential.publicKey).toString("base64");

      // Upsert user with passkey credential
      const userId = challengeRow.user_id;
      const { data: wallet } = await supabaseAdmin()
        .from("paylabs_dcw_wallets")
        .select("id, wallet_id, wallet_address")
        .eq("id", userId)
        .limit(1)
        .single();

      if (wallet) {
        // Update existing
        await supabaseAdmin()
          .from("paylabs_dcw_wallets")
          .update({
            passkey_credential_id: regCredential.id,
            passkey_public_key: publicKey,
            passkey_counter: regCredential.counter,
            display_name: email.split("@")[0],
          })
          .eq("id", userId);
      } else {
        // Insert new (wallet not created yet — will be created on first DCW run)
        await supabaseAdmin().from("paylabs_dcw_wallets").insert({
          id: userId,
          email,
          wallet_id: null,
          wallet_address: null,
          passkey_credential_id: regCredential.id,
          passkey_public_key: publicKey,
          passkey_counter: regCredential.counter,
          display_name: email.split("@")[0],
          status: "active",
        });
      }

      // Clean up challenge
      await supabaseAdmin()
        .from("paylabs_webauthn_challenges")
        .delete()
        .eq("email", email)
        .eq("type", "registration");

      // Create session
      const walletModeConflict = await rejectIfCreatorWalletActive(req);
      if (walletModeConflict) return walletModeConflict;

      const session = await createSession({
        sub: userId,
        email,
        walletId: wallet?.wallet_id || undefined,
        walletAddress: wallet?.wallet_address || undefined,
      });

      const resp = NextResponse.json({
        ok: true,
        userId,
        hasWallet: !!wallet?.wallet_id,
        walletAddress: wallet?.wallet_address || null,
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
    console.error("[passkey/register] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
