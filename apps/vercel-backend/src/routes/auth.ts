import { Hono } from "hono";
import type { Hex } from "viem";
import {
  generateNonce,
  verifySiwe,
  signJwt,
  getUserById,
  AuthError,
} from "../services/auth.js";
import { jwtAuth } from "../middleware/jwt.js";

type AuthVariables = {
  userId: string;
  walletAddress: string;
};

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

// POST /api/auth/nonce
// Returns a random nonce and a SIWE message template for the wallet to sign.
authRoutes.post("/nonce", async (c) => {
  try {
    const { nonce, message, expiresAt } = await generateNonce();
    return c.json({ nonce, message, expiresAt });
  } catch (err) {
    console.error("[auth/nonce]", err);
    return c.json({ error: "Failed to generate nonce" }, 500);
  }
});

// POST /api/auth/verify
// Body: { message: string, signature: string }
// Verifies SIWE signature, marks nonce as used, returns JWT.
authRoutes.post("/verify", async (c) => {
  try {
    const body = await c.req.json<{ message: string; signature: string }>();

    if (!body.message || !body.signature) {
      return c.json({ error: "message and signature are required" }, 400);
    }

    const { userId, walletAddress } = await verifySiwe({
      message: body.message,
      signature: body.signature as Hex,
    });

    const token = signJwt({ sub: userId, walletAddress });
    return c.json({ token, userId, walletAddress });
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    console.error("[auth/verify]", err);
    return c.json({ error: "Verification failed" }, 500);
  }
});

// GET /api/auth/me
// Requires Bearer JWT. Returns current user.
authRoutes.get("/me", jwtAuth, async (c) => {
  const userId = c.get("userId");
  const walletAddress = c.get("walletAddress");

  const user = await getUserById(userId);
  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    id: user.id,
    walletAddress: user.walletAddress,
    createdAt: user.createdAt.toISOString(),
  });
});
