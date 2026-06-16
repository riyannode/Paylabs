import { Hono } from "hono";

export const sitesRoutes = new Hono();

sitesRoutes.get("/", async (c) => {
  // TODO: List supported sites
  return c.json({ error: "Not implemented yet" }, 501);
});

sitesRoutes.get("/:id", async (c) => {
  // TODO: Get site by ID
  return c.json({ error: "Not implemented yet" }, 501);
});
