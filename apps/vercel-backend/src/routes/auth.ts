import { Hono } from "hono";

export const authRoutes = new Hono();

authRoutes.post("/nonce", async (c) => {
  // TODO: Generate nonce, store in auth_nonces table
  return c.json({ error: "Not implemented yet" }, 501);
});

authRoutes.post("/verify", async (c) => {
  // TODO: Verify wallet signature, return JWT
  return c.json({ error: "Not implemented yet" }, 501);
});

authRoutes.get("/me", async (c) => {
  // TODO: Return current user from JWT
  return c.json({ error: "Not implemented yet" }, 501);
});
