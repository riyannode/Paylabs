import { Hono } from "hono";

export const contentRoutes = new Hono();

contentRoutes.post("/resolve", async (c) => {
  // TODO: Resolve content URL to content item
  return c.json({ error: "Not implemented yet" }, 501);
});

contentRoutes.post("/quote", async (c) => {
  // TODO: Return price quote for content
  return c.json({ error: "Not implemented yet" }, 501);
});

contentRoutes.post("/unlock", async (c) => {
  // TODO: Unlock content after payment accepted
  return c.json({ error: "Not implemented yet" }, 501);
});
