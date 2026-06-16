import { Hono } from "hono";

export const aiRoutes = new Hono();

aiRoutes.post("/request", async (c) => {
  // TODO: Create AI search request (payment_required status)
  return c.json({ error: "Not implemented yet" }, 501);
});

aiRoutes.post("/execute", async (c) => {
  // TODO: Execute AI search after payment (Tavily + OpenAI)
  return c.json({ error: "Not implemented yet" }, 501);
});

aiRoutes.get("/:id", async (c) => {
  // TODO: Get AI request result
  return c.json({ error: "Not implemented yet" }, 501);
});
