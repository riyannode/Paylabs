import sql from "./client.js";

async function seed() {
  console.log("[seed] Upserting supported sites...");

  await sql`
    INSERT INTO paylabs_supported_sites (id, name, hosts, enabled, publish_target)
    VALUES
      ('arc-community', 'Arc Community', ARRAY['community.arc.io', 'community.arc.network'], true, true),
      ('sepiasearch', 'SepiaSearch', ARRAY['sepiasearch.org'], true, false)
    ON CONFLICT (id) DO NOTHING
  `;

  const sites = await sql`SELECT id, name, enabled FROM paylabs_supported_sites ORDER BY name`;
  console.log("[seed] Supported sites:", sites);

  console.log("[seed] Done.");
  await sql.end();
}

seed();
