/**
 * GET /api/paylabs/auth/session — Check current session
 * DELETE /api/paylabs/auth/session — Logout
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, SESSION_COOKIE_NAME } from "@/lib/paylabs/auth/session";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, authenticated: false });
  }
  return NextResponse.json({
    ok: true,
    authenticated: true,
    userId: session.sub,
    email: session.email,
    hasWallet: !!session.walletId,
    walletAddress: session.walletAddress || null,
  });
}

export async function DELETE() {
  const resp = NextResponse.json({ ok: true });
  resp.cookies.set(SESSION_COOKIE_NAME, "", { maxAge: 0, path: "/" });
  return resp;
}
