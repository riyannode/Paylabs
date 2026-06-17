import { Hono } from "hono";

export const receiptsRoutes = new Hono();

receiptsRoutes.get("/", async (c) => {
  // TODO: List receipts for current user
  return c.json({ error: "Not implemented yet" }, 501);
});

receiptsRoutes.get("/:id", async (c) => {
  // TODO: Get receipt by ID with batch status and txHash
  return c.json({ error: "Not implemented yet" }, 501);
});
