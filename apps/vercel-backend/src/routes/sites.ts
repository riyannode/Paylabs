import { Hono } from "hono";
import sql from "../db/client.js";

export const sitesRoutes = new Hono();

sitesRoutes.get("/", async (c) => {
  try {
    const rows = await sql`
      SELECT id, name, hosts, enabled, publish_target, config_json, created_at, updated_at
      FROM paylabs_supported_sites
      WHERE enabled = true
      ORDER BY name
    `;
    return c.json({ sites: rows });
  } catch (err: any) {
    console.error("[sites] list error:", err.message);
    return c.json({ error: "Failed to list sites", detail: err.message }, 500);
  }
});

sitesRoutes.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const rows = await sql`
      SELECT id, name, hosts, enabled, publish_target, config_json, created_at, updated_at
      FROM paylabs_supported_sites
      WHERE id = ${id}
    `;
    if (rows.length === 0) {
      return c.json({ error: "Site not found" }, 404);
    }
    return c.json({ site: rows[0] });
  } catch (err: any) {
    console.error("[sites] get error:", err.message);
    return c.json({ error: "Failed to get site", detail: err.message }, 500);
  }
});
