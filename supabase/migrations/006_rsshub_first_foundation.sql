-- Migration 006: RSSHub-First Foundation
-- Adds RSSHub routes, feed items, and citation receipts.
-- Does NOT truncate or drop any existing payment tables.

-- ─── RSSHub Routes ──────────────────────────────────────────
create table if not exists paylabs_rsshub_routes (
  id uuid primary key default gen_random_uuid(),
  rsshub_base_url text not null,
  route_path text not null,
  title text not null,
  description text,
  source_type text not null default 'rsshub',
  creator_wallet text not null,
  default_price_per_citation_usdc numeric not null default 0.000001,
  default_price_per_unlock_usdc numeric not null default 0.00001,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique(rsshub_base_url, route_path)
);

-- ─── Feed Items ─────────────────────────────────────────────
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
  creator_wallet text not null,
  price_per_citation_usdc numeric not null,
  price_per_unlock_usdc numeric not null,
  source_payload jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── Citation Receipts ──────────────────────────────────────
create table if not exists paylabs_citation_receipts (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  feed_item_id uuid references paylabs_feed_items(id) on delete set null,
  source_url text not null,
  source_title text,
  creator_wallet text not null,
  route_tier text,
  goal text,
  citation_reason text,
  amount_usdc numeric not null,
  payment_id text not null unique,
  payment_ref text,
  settlement_ref text,
  tx_hash text,
  status text not null check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

-- ─── Indexes ────────────────────────────────────────────────
create index if not exists idx_rsshub_routes_active on paylabs_rsshub_routes(is_active);
create index if not exists idx_feed_items_route on paylabs_feed_items(rsshub_route_id);
create index if not exists idx_feed_items_active on paylabs_feed_items(is_active);
create index if not exists idx_feed_items_sha on paylabs_feed_items(normalized_sha256);
create index if not exists idx_feed_items_published_at on paylabs_feed_items(published_at desc);
create index if not exists idx_citation_receipts_status on paylabs_citation_receipts(status);
create index if not exists idx_citation_receipts_feed_item on paylabs_citation_receipts(feed_item_id);
create index if not exists idx_citation_receipts_creator on paylabs_citation_receipts(creator_wallet);

-- ─── RLS ────────────────────────────────────────────────────
alter table paylabs_rsshub_routes enable row level security;
alter table paylabs_feed_items enable row level security;
alter table paylabs_citation_receipts enable row level security;

-- Public read: active routes only
create policy "public_read_active_routes"
  on paylabs_rsshub_routes for select
  using (is_active = true);

-- Public read: active feed items only
create policy "public_read_active_feed_items"
  on paylabs_feed_items for select
  using (is_active = true);

-- Public read: completed citation receipts only
create policy "public_read_completed_citation_receipts"
  on paylabs_citation_receipts for select
  using (status = 'completed');

-- No public INSERT/UPDATE/DELETE — all writes go through supabaseAdmin()
