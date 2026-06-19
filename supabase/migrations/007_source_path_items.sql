-- Migration 007: Source Path Items
-- RSSHub source path items for the proposal graph.
-- Links proposed learning paths to feed items (not legacy lessons).

create table if not exists paylabs_source_path_items (
  id uuid primary key default gen_random_uuid(),
  path_id uuid references paylabs_learning_paths(id) on delete cascade,
  feed_item_id uuid references paylabs_feed_items(id) on delete set null,
  order_index int not null,
  reason text,
  expected_value text,
  citation_price_usdc numeric not null,
  unlock_price_usdc numeric not null,
  creator_wallet text not null,
  source_url text not null,
  source_title text,
  source_hash text,
  status text not null default 'proposed' check (status in ('proposed', 'cited', 'unlocked', 'completed', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists idx_source_path_items_path on paylabs_source_path_items(path_id);
create index if not exists idx_source_path_items_feed_item on paylabs_source_path_items(feed_item_id);
create index if not exists idx_source_path_items_status on paylabs_source_path_items(status);

-- ─── RLS ────────────────────────────────────────────────────
alter table paylabs_source_path_items enable row level security;

-- No public read required yet. Writes must be server-side only through supabaseAdmin().
