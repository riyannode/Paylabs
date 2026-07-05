-- Migration 24: Visitor analytics — anonymous page visit tracking
-- Adds paylabs_page_visits table for counting unique website visitors.
-- No raw IP, no email, no wallet address stored.

create table if not exists paylabs_page_visits (
  id uuid primary key default gen_random_uuid(),
  visitor_hash text not null,
  path text not null,
  referrer text null,
  user_agent_hash text null,
  is_bot boolean not null default false,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_page_visits_created
  on paylabs_page_visits(created_at desc);

create index if not exists idx_page_visits_visitor
  on paylabs_page_visits(visitor_hash);

create index if not exists idx_page_visits_visitor_created
  on paylabs_page_visits(visitor_hash, created_at desc);

create index if not exists idx_page_visits_bot
  on paylabs_page_visits(is_bot)
  where is_bot = false;

-- RLS
alter table paylabs_page_visits enable row level security;

-- No public SELECT policy — only server-side supabaseAdmin() reads this table.
-- No public INSERT/UPDATE/DELETE policies — all writes via server-side API.
