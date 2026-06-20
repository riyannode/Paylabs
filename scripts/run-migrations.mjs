import postgres from 'postgres';
import { readFileSync } from 'fs';

const sql = postgres({
  host: 'aws-1-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.qosxyriijjqcfvzlqsal',
  password: 'REDACTED_SUPABASE_DB_PASSWORD',
  database: 'postgres',
  ssl: 'require',
  prepare: false,
});

const migrations = [
  'supabase/migrations/3_discovery_runs.sql',
  'supabase/migrations/4_agent_nanopayments.sql',
  'supabase/migrations/5_discovery_payments.sql',
];

try {
  for (const file of migrations) {
    const sql_content = readFileSync(file, 'utf8');
    console.log(`Applying ${file}...`);
    try {
      await sql.unsafe(sql_content);
      console.log(`  ✅ Applied`);
    } catch (e) {
      if (e.message?.includes('already exists')) {
        console.log(`  ⚠️ Already exists — skipping`);
      } else {
        console.error(`  ❌ Failed: ${e.message}`);
        throw e;
      }
    }
  }

  // Verify all expected tables
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name LIKE 'paylabs_%'
    ORDER BY table_name
  `;
  console.log('\nPaylabs tables:');
  for (const t of tables) {
    console.log(`  ${t.table_name}`);
  }
} finally {
  await sql.end();
}
