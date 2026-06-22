-- 9_paylabs_x402_visibility.sql
-- Canonical x402 visibility tables: run events, service payment events, receipts.
-- Replaces legacy paylabs_agent_nanopayments + paylabs_agent_batch_settlements.

create table if not exists paylabs_run_events (
  event_id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references paylabs_discovery_runs(id) on delete cascade,
  user_wallet text,
  route_tier text not null check (route_tier in ('easy', 'normal', 'advanced')),

  event_type text not null,
  actor_type text not null,
  actor_name text not null,
  target_type text,
  target_name text,

  status text not null,
  mode text,
  amount_usdc numeric,
  amount_atomic text,
  network text,
  pay_to text,
  x402_version int,
  tx_hash text,
  explorer_url text,

  safe_summary text,
  error text,
  sequence int not null,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()
);

create index if not exists idx_paylabs_run_events_run_seq
  on paylabs_run_events(discovery_run_id, sequence);

create index if not exists idx_paylabs_run_events_created
  on paylabs_run_events(created_at desc);

create table if not exists paylabs_service_payment_events (
  event_id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references paylabs_discovery_runs(id) on delete cascade,

  payment_edge_id text not null,
  buyer text not null,
  seller text not null,
  node_type text not null,

  status text not null check (
    status in ('planned', 'challenged', 'signed', 'verified', 'settled', 'paid', 'failed', 'skipped', 'audit_only')
  ),
  mode text not null check (mode in ('x402', 'x402_failed', 'audit_only')),
  amount_usdc numeric not null,
  amount_atomic text,
  network text,
  pay_to text,
  x402_version int,

  tx_hash text,
  explorer_url text,
  error text,
  safe_summary text,

  created_at timestamptz not null default now(),

  unique(discovery_run_id, payment_edge_id)
);

create index if not exists idx_paylabs_service_payment_events_run
  on paylabs_service_payment_events(discovery_run_id);

create index if not exists idx_paylabs_service_payment_events_created
  on paylabs_service_payment_events(created_at desc);

create table if not exists paylabs_receipts (
  receipt_id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null unique references paylabs_discovery_runs(id) on delete cascade,

  user_wallet text,
  selected_tier text not null check (selected_tier in ('easy', 'normal', 'advanced')),

  planned_cost_usdc numeric,
  actual_settled_usdc numeric not null default 0,
  remaining_budget_usdc numeric,
  service_fees_usdc numeric not null default 0,
  source_fees_usdc numeric not null default 0,
  creator_reserve_usdc numeric not null default 0,

  payment_count int not null default 0,
  last_tx_hash text,
  last_payment_at timestamptz,

  safe_receipt_summary text,
  created_at timestamptz not null default now()
);

create index if not exists idx_paylabs_receipts_created
  on paylabs_receipts(created_at desc);
