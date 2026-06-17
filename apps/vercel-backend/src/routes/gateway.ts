import { Hono } from "hono";

export const gatewayRoutes = new Hono();

gatewayRoutes.get("/status", async (c) => {
  // TODO: Return Gateway balance and status
  return c.json({ error: "Not implemented yet" }, 501);
});

gatewayRoutes.post("/deposit/requirements", async (c) => {
  // TODO: Return deposit requirements (approve + deposit to Gateway)
  return c.json({ error: "Not implemented yet" }, 501);
});

gatewayRoutes.post("/deposit/confirm", async (c) => {
  // TODO: Confirm deposit after on-chain tx
  return c.json({ error: "Not implemented yet" }, 501);
});

gatewayRoutes.post("/sync", async (c) => {
  // TODO: Sync Gateway balance
  return c.json({ error: "Not implemented yet" }, 501);
});
