import { readFileSync } from "fs";
import { join } from "path";
import sql from "./client.js";

async function migrate() {
  console.log("[migrate] Running schema.sql...");
  const schemaPath = join(import.meta.dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  try {
    await sql.unsafe(schema);
    console.log("[migrate] Schema applied successfully.");
  } catch (err: any) {
    console.error("[migrate] Failed:", err.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

migrate();
