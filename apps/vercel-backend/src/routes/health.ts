import { Hono } from "hono";
import sql from "../db/client.js";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) =>
  c.json({
    status: "ok",
    service: "paylabs-vercel-backend",
    timestamp: new Date().toISOString(),
  })
);

healthRoutes.get("/db", async (c) => {
  try {
    const result = await sql`SELECT 1 as ok, now() as db_time`;
    const sites = await sql`SELECT count(*)::int as total FROM paylabs_supported_sites WHERE enabled = true`;
    return c.json({
      status: "ok",
      db: "connected",
      db_time: result[0].db_time,
      active_sites: sites[0].total,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[health/db] error:", err.message);
    return c.json({
      status: "error",
      db: "disconnected",
      error: err.message,
      timestamp: new Date().toISOString(),
    }, 503);
  }
});
