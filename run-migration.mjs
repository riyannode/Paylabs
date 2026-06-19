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

console.log("Applying incremental migration...\n");

// ─── paylabs_rsshub_routes ─────────────────────────────
// 1. Add is_monetized column
await sql`ALTER TABLE paylabs_rsshub_routes ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false`;
console.log("✅ rsshub_routes: added is_monetized");

// 2. Make creator_wallet nullable
await sql`ALTER TABLE paylabs_rsshub_routes ALTER COLUMN creator_wallet DROP NOT NULL`;
console.log("✅ rsshub_routes: creator_wallet now nullable");

// 3. Add unique constraint if not exists
try {
  await sql`ALTER TABLE paylabs_rsshub_routes ADD CONSTRAINT uq_rsshub_routes_base_path UNIQUE (rsshub_base_url, route_path)`;
  console.log("✅ rsshub_routes: added unique(rsshub_base_url, route_path)");
} catch (e) {
  if (e.message?.includes('already exists')) {
    console.log("⏭️  rsshub_routes: unique constraint already exists");
  } else {
    console.log("⚠️  rsshub_routes: unique constraint error:", e.message);
  }
}

// ─── paylabs_feed_items ─────────────────────────────────
// 1. Add is_monetized column
await sql`ALTER TABLE paylabs_feed_items ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false`;
console.log("✅ feed_items: added is_monetized");

// 2. Make creator_wallet nullable
await sql`ALTER TABLE paylabs_feed_items ALTER COLUMN creator_wallet DROP NOT NULL`;
console.log("✅ feed_items: creator_wallet now nullable");

// 3. Fix price defaults
await sql`ALTER TABLE paylabs_feed_items ALTER COLUMN price_per_citation_usdc SET DEFAULT 0`;
await sql`ALTER TABLE paylabs_feed_items ALTER COLUMN price_per_unlock_usdc SET DEFAULT 0`;
console.log("✅ feed_items: price defaults set to 0");

// ─── paylabs_source_path_items ──────────────────────────
// 1. Add is_monetized column
await sql`ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false`;
console.log("✅ source_path_items: added is_monetized");

// 2. Add evidence_score
await sql`ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS evidence_score numeric`;
console.log("✅ source_path_items: added evidence_score");

// 3. Add marginal_value_score
await sql`ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS marginal_value_score numeric`;
console.log("✅ source_path_items: added marginal_value_score");

// ─── paylabs_source_payments ────────────────────────────
// 1. Add split fields
await sql`ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS creator_amount_usdc numeric NOT NULL DEFAULT 0`;
await sql`ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS agent_fee_usdc numeric NOT NULL DEFAULT 0`;
await sql`ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS treasury_fee_usdc numeric NOT NULL DEFAULT 0`;
await sql`ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS split_rule_version text NOT NULL DEFAULT 'v1_85_10_5'`;
console.log("✅ source_payments: added split fields");

// ─── paylabs_agent_actions ──────────────────────────────
const agentActionCols = [
  { name: 'source_path_id', type: 'uuid', null: true },
  { name: 'feed_item_id', type: 'uuid', null: true },
  { name: 'agent_name', type: 'text', null: true },
  { name: 'route_tier', type: 'text', null: true },
  { name: 'decision_label', type: 'text', null: true },
  { name: 'evidence_score', type: 'numeric', null: true },
  { name: 'marginal_value_score', type: 'numeric', null: true },
  { name: 'cost_usdc', type: 'numeric', null: false },
  { name: 'max_cost_usdc', type: 'numeric', null: true },
  { name: 'stop_reason', type: 'text', null: true },
  { name: 'paid_via_payment_adapter', type: 'boolean', null: false },
  { name: 'metadata', type: 'jsonb', null: true },
];

for (const col of agentActionCols) {
  const defaultClause = col.type === 'numeric' && col.name === 'cost_usdc' ? ' DEFAULT 0' :
                        col.type === 'boolean' && col.name === 'paid_via_payment_adapter' ? ' DEFAULT false' :
                        '';
  const nullClause = col.null ? '' : ' NOT NULL';
  await sql.unsafe(`ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}${nullClause}${defaultClause}`);
  console.log(`✅ agent_actions: added ${col.name}`);
}

// ─── Indexes for new columns ────────────────────────────
await sql`CREATE INDEX IF NOT EXISTS idx_rsshub_routes_monetized ON paylabs_rsshub_routes(is_monetized) WHERE is_monetized = true`;
await sql`CREATE INDEX IF NOT EXISTS idx_feed_items_monetized ON paylabs_feed_items(is_monetized) WHERE is_monetized = true`;
await sql`CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_name ON paylabs_agent_actions(agent_name)`;
await sql`CREATE INDEX IF NOT EXISTS idx_agent_actions_source_path ON paylabs_agent_actions(source_path_id)`;
console.log("✅ indexes created");

// ─── RLS policies ───────────────────────────────────────
try {
  await sql`CREATE POLICY public_read_active_feed_items ON paylabs_feed_items FOR SELECT USING (is_active = true)`;
  console.log("✅ RLS policy: public_read_active_feed_items");
} catch (e) {
  if (e.message?.includes('already exists')) {
    console.log("⏭️  RLS policy already exists: public_read_active_feed_items");
  } else {
    console.log("⚠️  RLS policy error:", e.message);
  }
}

try {
  await sql`CREATE POLICY public_read_active_rsshub_routes ON paylabs_rsshub_routes FOR SELECT USING (is_active = true)`;
  console.log("✅ RLS policy: public_read_active_rsshub_routes");
} catch (e) {
  if (e.message?.includes('already exists')) {
    console.log("⏭️  RLS policy already exists: public_read_active_rsshub_routes");
  } else {
    console.log("⚠️  RLS policy error:", e.message);
  }
}

console.log("\n🎉 Migration complete!");
await sql.end();
