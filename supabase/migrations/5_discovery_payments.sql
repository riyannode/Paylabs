-- PayLabs Migration: Discovery Payments (x402 settlement tracking)
-- Tracks discovery fee payments via Circle Gateway x402.
-- PR #16: Wire real Circle Gateway x402 settlement for agent nanopayments.

create table if not exists paylabs_discovery_payments (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid references paylabs_discovery_runs(id) on delete set null,
  user_wallet text not null,
  route_tier text not null,
  payment_kind text not null default 'discovery_fee',
  payment_route text not null default 'circle_gateway_x402',
  amount_usdc numeric not null,
  agent_nanopayment_total_usdc numeric not null default 0,
  gateway_buffer_usdc numeric not null default 0,
  treasury_fee_usdc numeric not null default 0,
  remaining_optimizer_budget_usdc numeric,
  x402_payment_ref text,
  x402_settlement_ref text,
  gateway_response jsonb,
  status text not null default 'quoted'
    check (status in (
      'quoted',
      'authorized',
      'settlement_pending',
      'paid',
      'failed',
      'setup_required'
    )),
  failure_reason text,
  nonce_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_discovery_payments_run
  on paylabs_discovery_payments(discovery_run_id);

create index if not exists idx_discovery_payments_wallet
  on paylabs_discovery_payments(user_wallet);

create index if not exists idx_discovery_payments_status
  on paylabs_discovery_payments(status, created_at desc);

create index if not exists idx_discovery_payments_nonce
  on paylabs_discovery_payments(nonce_hash)
  where nonce_hash is not null;

-- RLS
alter table paylabs_discovery_payments enable row level security;

create policy "public_read_discovery_payments" on paylabs_discovery_payments
  for select using (true);

-- No public INSERT/UPDATE/DELETE policies.
-- All writes must go through server-side supabaseAdmin().

-- Updated_at trigger
create or replace function update_discovery_payments_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trigger_discovery_payments_updated_at
  before update on paylabs_discovery_payments
  for each row
  execute function update_discovery_payments_updated_at();
