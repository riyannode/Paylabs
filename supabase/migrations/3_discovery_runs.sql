-- PayLabs Migration: Discovery-only runs and pending attribution
-- When 0 monetized sources exist, track discovery results separately.

create table if not exists paylabs_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  goal text not null,
  route_tier text not null,
  status text not null check (status in ('discovery_only', 'paid_path_available', 'failed')),
  candidate_count int not null default 0,
  eligible_source_count int not null default 0,
  unclaimed_source_count int not null default 0,
  agent_trace jsonb,
  created_at timestamptz not null default now()
);

create table if not exists paylabs_discovery_run_items (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references paylabs_discovery_runs(id) on delete cascade,
  feed_item_id uuid references paylabs_feed_items(id) on delete set null,
  source_url text not null,
  source_title text,
  publisher text,
  claim_status text not null default 'unclaimed'
    check (claim_status in ('unclaimed', 'pending_claim', 'verified')),
  is_monetized boolean not null default false,
  evidence_score numeric,
  marginal_value_score numeric,
  rank_index int,
  reason text,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_discovery_runs_user
  on paylabs_discovery_runs(user_wallet, created_at desc);

create index if not exists idx_discovery_run_items_run
  on paylabs_discovery_run_items(discovery_run_id);

create index if not exists idx_discovery_run_items_feed
  on paylabs_discovery_run_items(feed_item_id);

-- RLS
alter table paylabs_discovery_runs enable row level security;
alter table paylabs_discovery_run_items enable row level security;

create policy "public_read_discovery_runs" on paylabs_discovery_runs
  for select using (true);

create policy "public_read_discovery_run_items" on paylabs_discovery_run_items
  for select using (true);

-- No public INSERT/UPDATE/DELETE policies.
-- All writes must go through server-side supabaseAdmin().
