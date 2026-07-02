/**
 * POST /api/paylabs/auth/otp/verify
 *
 * Verify a 6-digit OTP code and create a session.
 *
 * Security:
 *   - Compares SHA-256 hash (never reads plaintext from DB)
 *   - Max 5 attempts per code (auto-incremented)
 *   - Code expires after 5 minutes
 *   - On success: deletes all OTP rows for this email, creates JWT session
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { hashOtp, OTP_MAX_ATTEMPTS } from "@/lib/paylabs/auth/otp";
import { createSession, sessionCookieOptions } from "@/lib/paylabs/auth/session";

import { getSession as getUcwSession } from "@/lib/paylabs/ucw";
import { randomUUID } from "node:crypto";


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
    const { email: rawEmail, code: rawCode } = await req.json();
    const email = (rawEmail || "").trim().toLowerCase();
    const code = (rawCode || "").trim();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ ok: false, error: "Valid email required" }, { status: 400 });
    }
    if (!code || code.length !== 6) {
      return NextResponse.json({ ok: false, error: "6-digit code required" }, { status: 400 });
    }

    // ── Find latest unexpired OTP for this email ─────────────
    const { data: otpRow } = await supabaseAdmin()
      .from("paylabs_email_otps")
      .select("id, code_hash, attempts, expires_at")
      .eq("email", email)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!otpRow) {
      return NextResponse.json(
        { ok: false, error: "No valid code found. Request a new one." },
        { status: 400 }
      );
    }

    // ── Check attempts ───────────────────────────────────────
    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
      // Delete exhausted code
      await supabaseAdmin().from("paylabs_email_otps").delete().eq("id", otpRow.id);
      return NextResponse.json(
        { ok: false, error: "Too many attempts. Request a new code." },
        { status: 429 }
      );
    }

    // ── Increment attempts ───────────────────────────────────
    await supabaseAdmin()
      .from("paylabs_email_otps")
      .update({ attempts: otpRow.attempts + 1 })
      .eq("id", otpRow.id);

    // ── Compare hash ─────────────────────────────────────────
    const inputHash = hashOtp(code);
    if (inputHash !== otpRow.code_hash) {
      return NextResponse.json({ ok: false, error: "Invalid code" }, { status: 400 });
    }

    // ── Valid! Clean up all OTPs for this email ──────────────
    await supabaseAdmin().from("paylabs_email_otps").delete().eq("email", email);

    // ── Find or create user ──────────────────────────────────
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
        display_name: email.split("@")[0],
        status: "active",
      });
    }

    // ── Create session ───────────────────────────────────────
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
      hasWallet: !!walletId,
      walletAddress: walletAddress || null,
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
    console.error("[otp/verify] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
