import { Hono } from "hono";

export const accessRoutes = new Hono();

accessRoutes.get("/check", async (c) => {
  // TODO: Check if user has access pass for content
  return c.json({ error: "Not implemented yet" }, 501);
});
