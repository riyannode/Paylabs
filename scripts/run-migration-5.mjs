import postgres from 'postgres';
import { readFileSync } from 'fs';

const sql = postgres({
  host: 'aws-1-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.qosxyriijjqcfvzlqsal',
  password: 'jancok188900',
  database: 'postgres',
  ssl: 'require',
  prepare: false,
});

const migration = readFileSync('supabase/migrations/5_discovery_payments.sql', 'utf8');

try {
  console.log('Applying migration 5_discovery_payments.sql...');
  await sql.unsafe(migration);
  console.log('✅ Migration applied successfully');

  // Verify table exists
  const result = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'paylabs_discovery_payments'
    ORDER BY ordinal_position
  `;
  console.log(`\nTable has ${result.length} columns:`);
  for (const row of result) {
    console.log(`  ${row.column_name}: ${row.data_type}`);
  }
} catch (e) {
  if (e.message?.includes('already exists')) {
    console.log('⚠️ Table already exists — skipping (idempotent)');
  } else {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
  }
} finally {
  await sql.end();
}
