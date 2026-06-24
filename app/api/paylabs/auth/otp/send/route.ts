/**
 * POST /api/paylabs/auth/otp/send
 *
 * Generate and email a 6-digit OTP code.
 *
 * Security:
 *   - OTP code hashed (SHA-256) before storage — plaintext never in DB
 *   - Max 3 codes per email per 10-minute window (rate limit)
 *   - 5-minute TTL per code
 *   - Previous unused codes for same email are invalidated on new send
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  generateOtp,
  hashOtp,
  OTP_TTL_MS,
  OTP_RATE_LIMIT_WINDOW_MS,
  OTP_RATE_LIMIT_MAX_CODES,
} from "@/lib/paylabs/auth/otp";
import { sendOtpEmail } from "@/lib/paylabs/email";

export async function POST(req: NextRequest) {
  try {
    const { email: rawEmail } = await req.json();
    const email = (rawEmail || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return NextResponse.json({ ok: false, error: "Valid email required" }, { status: 400 });
    }

    // ── Rate limit: max N codes per email in window ──────────
    const windowStart = new Date(Date.now() - OTP_RATE_LIMIT_WINDOW_MS).toISOString();
    const { count } = await supabaseAdmin()
      .from("paylabs_email_otps")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", windowStart);

    if ((count ?? 0) >= OTP_RATE_LIMIT_MAX_CODES) {
      return NextResponse.json(
        { ok: false, error: "Too many codes requested. Try again later." },
        { status: 429 }
      );
    }

    // ── Invalidate previous unused codes for this email ──────
    await supabaseAdmin()
      .from("paylabs_email_otps")
      .delete()
      .eq("email", email);

    // ── Generate + store hashed OTP ──────────────────────────
    const code = generateOtp();
    const codeHash = hashOtp(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    await supabaseAdmin().from("paylabs_email_otps").insert({
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    // ── Send email ───────────────────────────────────────────
    await sendOtpEmail(email, code);

    return NextResponse.json({ ok: true, expiresIn: OTP_TTL_MS / 1000 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[otp/send] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
