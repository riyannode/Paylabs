import { Hono } from "hono";

export const settlementRoutes = new Hono();

settlementRoutes.get("/batches", async (c) => {
  // TODO: List settlement batches
  return c.json({ error: "Not implemented yet" }, 501);
});

settlementRoutes.get("/batches/:id", async (c) => {
  // TODO: Get batch by ID
  return c.json({ error: "Not implemented yet" }, 501);
});

settlementRoutes.post("/batches/:id/sync", async (c) => {
  // TODO: Sync batch with Gateway/Arc to get real txHash
  return c.json({ error: "Not implemented yet" }, 501);
});
