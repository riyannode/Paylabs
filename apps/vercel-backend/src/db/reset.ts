import sql from "./client.js";

const TABLES = [
  "paylabs_ai_requests",
  "paylabs_receipts",
  "paylabs_access_passes",
  "paylabs_payment_attempts",
  "paylabs_settlement_batches",
  "paylabs_content_items",
  "paylabs_supported_sites",
  "paylabs_auth_nonces",
  "paylabs_users",
];

async function reset() {
  console.log("[reset] Dropping all Paylabs tables...");

  for (const table of TABLES) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
    console.log(`[reset] Dropped ${table}`);
  }

  console.log("[reset] All tables dropped. Run `npm run db:migrate` to recreate.");
  await sql.end();
}

reset();
