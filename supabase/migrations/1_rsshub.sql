-- PayLabs RSSHub-only schema
-- Source discovery, source paths, source payments, and agent payment audit.
-- Phase 1: verified monetization gate

create extension if not exists pgcrypto;

create table if not exists paylabs_rsshub_routes (
  id uuid primary key default gen_random_uuid(),
  rsshub_base_url text not null,
  route_path text not null,
  title text not null,
  description text,
  source_type text not null default 'rsshub',
  creator_wallet text,
  is_monetized boolean not null default false,
  default_price_per_citation_usdc numeric not null default 0,
  default_price_per_unlock_usdc numeric not null default 0,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  verification_status text not null default 'unverified' check (verification_status in ('verified', 'pending_claim', 'unverified', 'rejected', 'disputed')),
  verification_method text,
  verified_at timestamptz,
  verified_by text,
  ownership_proof_url text,
  ownership_proof_hash text,
  created_at timestamptz not null default now(),
  unique(rsshub_base_url, route_path)
);

create table if not exists paylabs_feed_items (
  id uuid primary key default gen_random_uuid(),
  rsshub_route_id uuid references paylabs_rsshub_routes(id) on delete cascade,
  canonical_url text not null unique,
  title text,
  summary text,
  author_name text,
  publisher text,
  published_at timestamptz,
  tags text[],
  normalized_sha256 text,
  content_sha256 text,
  creator_wallet text,
  is_monetized boolean not null default false,
  price_per_citation_usdc numeric not null default 0,
  price_per_unlock_usdc numeric not null default 0,
  source_payload jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists paylabs_source_paths (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  goal text not null,
  budget_usdc numeric not null,
  effective_spend_cap_usdc numeric not null default 0,
  estimated_total_usdc numeric not null default 0,
  estimated_creator_payout_usdc numeric not null default 0,
  estimated_agent_fee_usdc numeric not null default 0,
  estimated_treasury_fee_usdc numeric not null default 0,
  route_tier text not null check (route_tier in ('normal', 'advanced', 'premium')),
  route_config jsonb,
  route_limits jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'active', 'completed', 'cancelled')),
  stop_reason text,
  stop_limit_hit boolean not null default false,
  agent_reasoning_summary text,
  agent_trace jsonb,
  created_by_agent_id text not null default 'paylabs-langgraph-v1',
  created_at timestamptz not null default now()
);

create table if not exists paylabs_source_path_items (
  id uuid primary key default gen_random_uuid(),
  source_path_id uuid not null references paylabs_source_paths(id) on delete cascade,
  feed_item_id uuid references paylabs_feed_items(id) on delete set null,
  order_index int not null,
  reason text,
  expected_value text,
  source_url text not null,
  source_title text,
  publisher text,
  author_name text,
  normalized_sha256 text,
  content_sha256 text,
  source_hash text,
  creator_wallet text,
  is_monetized boolean not null default false,
  citation_price_usdc numeric not null default 0,
  unlock_price_usdc numeric not null default 0,
  evidence_score numeric,
  marginal_value_score numeric,
  status text not null default 'proposed' check (status in ('proposed', 'cited', 'unlocked', 'completed', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists paylabs_route_payments (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  route_tier text not null check (route_tier in ('normal', 'advanced', 'premium')),
  goal text not null,
  input_hash text not null,
  amount_usdc numeric not null,
  payment_id text not null unique,
  payment_ref text,
  settlement_ref text,
  tx_hash text,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists paylabs_source_payments (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  source_path_id uuid references paylabs_source_paths(id) on delete set null,
  source_path_item_id uuid references paylabs_source_path_items(id) on delete set null,
  feed_item_id uuid references paylabs_feed_items(id) on delete set null,
  payment_kind text not null check (payment_kind in ('citation', 'unlock')),
  source_url text not null,
  source_title text,
  creator_wallet text not null,
  route_tier text,
  goal text,
  payment_reason text,
  amount_usdc numeric not null,
  creator_amount_usdc numeric not null default 0,
  agent_fee_usdc numeric not null default 0,
  treasury_fee_usdc numeric not null default 0,
  split_rule_version text not null default 'v1_85_10_5',
  payment_id text not null unique,
  payment_ref text,
  settlement_ref text,
  tx_hash text,
  status text not null check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists paylabs_agent_payments (
  id uuid primary key default gen_random_uuid(),
  buyer_agent_id text not null,
  provider_agent_id text not null,
  user_wallet text not null,
  route_tier text,
  service_type text not null,
  resource_url text,
  input_hash text not null,
  output_hash text,
  amount_usdc numeric not null,
  payment_id text not null unique,
  payment_ref text,
  settlement_ref text,
  tx_hash text,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists paylabs_agent_actions (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  agent_id text not null,
  action_type text not null,
  agent_name text,
  route_tier text,
  decision_label text,
  input_hash text,
  output_hash text,
  status text not null,
  source_path_id uuid,
  feed_item_id uuid,
  evidence_score numeric,
  marginal_value_score numeric,
  cost_usdc numeric not null default 0,
  max_cost_usdc numeric,
  stop_reason text,
  paid_via_payment_adapter boolean not null default false,
  policy_decision jsonb,
  metadata jsonb,
  payment_id text,
  created_at timestamptz not null default now()
);

-- ─── Indexes ───────────────────────────────────────────────────────

create index if not exists idx_rsshub_routes_active on paylabs_rsshub_routes(is_active);
create index if not exists idx_rsshub_routes_monetized on paylabs_rsshub_routes(is_monetized) where is_monetized = true;
create index if not exists idx_rsshub_routes_verified on paylabs_rsshub_routes(verification_status) where verification_status = 'verified';
create index if not exists idx_feed_items_route on paylabs_feed_items(rsshub_route_id);
create index if not exists idx_feed_items_active on paylabs_feed_items(is_active);
create index if not exists idx_feed_items_monetized on paylabs_feed_items(is_monetized) where is_monetized = true;
create index if not exists idx_feed_items_published_at on paylabs_feed_items(published_at desc);
create index if not exists idx_feed_items_sha on paylabs_feed_items(normalized_sha256);
create index if not exists idx_source_paths_user on paylabs_source_paths(user_wallet);
create index if not exists idx_source_paths_status on paylabs_source_paths(status);
create index if not exists idx_source_path_items_source_path on paylabs_source_path_items(source_path_id);
create index if not exists idx_source_path_items_feed_item on paylabs_source_path_items(feed_item_id);
create index if not exists idx_source_path_items_status on paylabs_source_path_items(status);
create index if not exists idx_route_payments_user on paylabs_route_payments(user_wallet);
create index if not exists idx_source_payments_user on paylabs_source_payments(user_wallet);
create index if not exists idx_source_payments_creator on paylabs_source_payments(creator_wallet);
create index if not exists idx_source_payments_feed_item on paylabs_source_payments(feed_item_id);
create index if not exists idx_source_payments_source_path_item on paylabs_source_payments(source_path_item_id);
create index if not exists idx_agent_payments_user on paylabs_agent_payments(user_wallet);
create index if not exists idx_agent_actions_agent_name on paylabs_agent_actions(agent_name);
create index if not exists idx_agent_actions_source_path on paylabs_agent_actions(source_path_id);

create unique index if not exists uq_completed_source_payment_user_feed_item
  on paylabs_source_payments(user_wallet, feed_item_id, payment_kind)
  where status = 'completed' and feed_item_id is not null;

create unique index if not exists uq_completed_source_payment_user_path_item
  on paylabs_source_payments(user_wallet, source_path_item_id, payment_kind)
  where status = 'completed' and source_path_item_id is not null;

-- ─── RLS ───────────────────────────────────────────────────────────

alter table paylabs_rsshub_routes enable row level security;
alter table paylabs_feed_items enable row level security;
alter table paylabs_source_paths enable row level security;
alter table paylabs_source_path_items enable row level security;
alter table paylabs_route_payments enable row level security;
alter table paylabs_source_payments enable row level security;
alter table paylabs_agent_payments enable row level security;
alter table paylabs_agent_actions enable row level security;

create policy "public_read_active_rsshub_routes" on paylabs_rsshub_routes
  for select using (is_active = true);

create policy "public_read_active_feed_items" on paylabs_feed_items
  for select using (is_active = true);

create policy "public_read_completed_source_payments" on paylabs_source_payments
  for select using (status = 'completed');

-- No public INSERT/UPDATE/DELETE policies.
-- All writes must go through server-side supabaseAdmin().
