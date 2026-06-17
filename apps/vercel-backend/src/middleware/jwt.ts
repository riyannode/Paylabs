import type { Context, Next } from "hono";
import { verifyJwt, AuthError } from "../services/auth.js";

/**
 * Hono middleware that extracts and verifies a Bearer JWT.
 * Sets "userId" and "walletAddress" on the context via c.set().
 * Returns 401 on failure.
 *
 * Uses `as any` for c.set() because Hono's Context generics
 * don't propagate Variables through standalone middleware functions.
 * The downstream route handler declares the proper Variables type.
 */
export async function jwtAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const { sub, walletAddress } = verifyJwt(token);
    // c.set on a generic Context requires `as any` for custom variable keys
    (c as any).set("userId", sub);
    (c as any).set("walletAddress", walletAddress);
    await next();
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401);
    }
    return c.json({ error: "Authentication failed" }, 401);
  }
}
