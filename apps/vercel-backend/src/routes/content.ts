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

// Renamed from /unlock → /open-thread
// A "paid thread open" is one accepted payment that returns one redirect_url.
// No content proxying, no access passes, no content body returned.
contentRoutes.post("/open-thread", async (c) => {
  // TODO: Accept x402 payment for thread_open purpose, return redirect_url
  return c.json({ error: "Not implemented yet" }, 501);
});
