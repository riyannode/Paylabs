/**
 * DCW Session Management
 *
 * JWT-based sessions using jose (Edge-compatible).
 * Sessions are stored in httpOnly cookies.
 *
 * Session payload: { sub: user_id, email: string, iat, exp }
 */

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SESSION_COOKIE = "paylabs_dcw_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

function getSecret(): Uint8Array {
  const secret = process.env.DCW_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("DCW_SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY required");
  return new TextEncoder().encode(secret);
}

export interface DcwSession {
  sub: string;   // user_id (uuid from paylabs_dcw_wallets)
  email: string;
  walletId?: string;
  walletAddress?: string;
}

/**
 * Create a signed JWT session token.
 */
export async function createSession(payload: DcwSession): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .setIssuer("paylabs")
    .setSubject(payload.sub)
    .sign(getSecret());
}

/**
 * Verify and decode a session token.
 * Returns null if invalid or expired.
 */
export async function verifySession(token: string): Promise<DcwSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "paylabs",
    });
    return payload as unknown as DcwSession;
  } catch {
    return null;
  }
}

/**
 * Get the current session from the cookie.
 * Returns null if no session or invalid.
 */
export async function getSession(): Promise<DcwSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/**
 * Set the session cookie (for use in route handlers).
 */
export function sessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

/**
 * Clear the session cookie name (for logout).
 */
export const SESSION_COOKIE_NAME = SESSION_COOKIE;
