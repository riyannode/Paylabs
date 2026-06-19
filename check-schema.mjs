import postgres from 'postgres';

const sql = postgres({
  host: 'aws-1-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.qosxyriijjqcfvzlqsal',
  password: 'REDACTED_SUPABASE_DB_PASSWORD',
  database: 'postgres',
  ssl: 'require',
  prepare: false
});

// Check existing tables
const tables = await sql`
  SELECT table_name FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_name LIKE 'paylabs%'
  ORDER BY table_name
`;
console.log("Existing tables:", JSON.stringify(tables.map(t => t.table_name)));

// Check columns on key tables
for (const t of ['paylabs_rsshub_routes', 'paylabs_feed_items', 'paylabs_source_path_items', 'paylabs_source_payments', 'paylabs_agent_actions']) {
  const cols = await sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = ${t}
    ORDER BY ordinal_position
  `;
  console.log(`\n${t} columns:`);
  for (const c of cols) {
    console.log(`  ${c.column_name} ${c.data_type} null=${c.is_nullable} default=${c.column_default || 'none'}`);
  }
}

await sql.end();
