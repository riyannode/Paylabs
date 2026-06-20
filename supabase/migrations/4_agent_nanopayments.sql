-- PayLabs Migration: Agent Nanopayment Ledger + Batch Settlement
-- Each paid agent capability call costs exactly 0.000001 USDC.
-- 7 agents per discovery run.
-- All payment-moving feature flags default false.

-- ─── Agent Nanopayments ────────────────────────────────────────
create table if not exists paylabs_agent_nanopayments (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid references paylabs_discovery_runs(id) on delete cascade,
  receipt_id uuid not null default gen_random_uuid(),
  user_wallet text not null,
  payer_agent text not null default 'paylabs_treasury',
  payee_agent text not null,
  route_tier text not null,
  agent_name text not null,
  capability text not null,
  agent_wallet text not null default '',
  price_usdc numeric not null default 0.000001,
  settlement_mode text not null default 'nano'
    check (settlement_mode in ('nano', 'batch')),
  payment_route text not null default 'circle_gateway_x402',
  payment_kind text not null default 'agent_capability_fee',
  x402_payment_ref text,
  x402_settlement_ref text,
  circle_transfer_id text,
  input_hash text,
  output_hash text,
  receipt_url text,
  status text not null default 'planned'
    check (status in ('planned', 'quoted', 'authorized', 'completed', 'settlement_pending', 'paid', 'failed', 'skipped')),
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ─── Agent Batch Settlements ───────────────────────────────────
create table if not exists paylabs_agent_batch_settlements (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid references paylabs_discovery_runs(id) on delete cascade,
  route_tier text not null,
  agent_count int not null default 7,
  agent_total_usdc numeric not null,
  treasury_fee_usdc numeric not null,
  gateway_buffer_usdc numeric not null,
  circle_batch_id text,
  x402_batch_ref text,
  status text not null default 'planned'
    check (status in ('planned', 'authorized', 'settlement_pending', 'paid', 'failed', 'skipped')),
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ─── Indexes ───────────────────────────────────────────────────
create index if not exists idx_nanopayments_run
  on paylabs_agent_nanopayments(discovery_run_id);

create index if not exists idx_nanopayments_receipt
  on paylabs_agent_nanopayments(receipt_id);

create index if not exists idx_nanopayments_status
  on paylabs_agent_nanopayments(status, created_at desc);

create index if not exists idx_batch_settlements_run
  on paylabs_agent_batch_settlements(discovery_run_id);

create index if not exists idx_batch_settlements_status
  on paylabs_agent_batch_settlements(status, created_at desc);

-- ─── RLS ───────────────────────────────────────────────────────
alter table paylabs_agent_nanopayments enable row level security;
alter table paylabs_agent_batch_settlements enable row level security;

create policy "public_read_nanopayments" on paylabs_agent_nanopayments
  for select using (true);

create policy "public_read_batch_settlements" on paylabs_agent_batch_settlements
  for select using (true);

-- No public INSERT/UPDATE/DELETE policies.
-- All writes must go through server-side supabaseAdmin().
