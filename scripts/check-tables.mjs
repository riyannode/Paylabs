import postgres from 'postgres';

const sql = postgres({
  host: 'aws-1-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.qosxyriijjqcfvzlqsal',
  password: 'REDACTED_SUPABASE_DB_PASSWORD',
  database: 'postgres',
  ssl: 'require',
  prepare: false,
});

try {
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;
  console.log('Existing tables:');
  for (const t of tables) {
    console.log(`  ${t.table_name}`);
  }
} finally {
  await sql.end();
}
