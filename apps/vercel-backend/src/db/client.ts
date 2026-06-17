import postgres from "postgres";
import { config } from "../config.js";

function createSql() {
  const url = config.databaseUrl;
  if (!url) {
    // No DB configured — return a stub that throws on use
    return postgres({ host: "localhost", port: 1 }); // will fail on connect
  }

  // Parse URL manually to avoid postgres.js URL parsing issues with Supabase pooler usernames
  const parsed = new URL(url);
  return postgres({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    database: parsed.pathname.slice(1) || "postgres",
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

const sql = createSql();

export default sql;
