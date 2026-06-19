-- Migration 004: Agent-to-Agent Service Payments
-- Adds agent provider registry and agent service call tracking.
-- Supports RFB 03: agent-to-agent nanopayment networks.
-- All payments go through ArcLayer Runner — no local keys, no fake payment IDs.

-- ─── Agent Provider Registry ──────────────────────────────────────
create table if not exists paylabs_agent_providers (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null unique,
  service_type text not null,
  endpoint_url text not null,
  wallet_address text not null,
  price_usdc numeric not null,
  route_tiers_supported text[] not null default array['normal','advanced','premium'],
  reputation_score numeric not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─── Agent Service Calls ─────────────────────────────────────────
create table if not exists paylabs_agent_service_calls (
  id uuid primary key default gen_random_uuid(),
  buyer_agent_id text not null,
  provider_agent_id text not null,
  user_wallet text not null,
  route_tier text not null,
  service_type text not null,
  resource_url text not null,
  input_hash text not null,
  output_hash text,
  amount_usdc numeric not null,
  payment_id text,
  payment_ref text,
  settlement_ref text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now()
);

-- ─── Indexes ─────────────────────────────────────────────────────
create index if not exists idx_agent_providers_service_type on paylabs_agent_providers(service_type);
create index if not exists idx_agent_providers_active on paylabs_agent_providers(is_active) where is_active = true;
create index if not exists idx_agent_service_calls_buyer on paylabs_agent_service_calls(buyer_agent_id);
create index if not exists idx_agent_service_calls_provider on paylabs_agent_service_calls(provider_agent_id);
create index if not exists idx_agent_service_calls_status on paylabs_agent_service_calls(status);

-- ─── Seed: Source Verifier Provider ──────────────────────────────
-- wallet_address is placeholder — app code resolves from env at runtime
insert into paylabs_agent_providers (agent_id, service_type, endpoint_url, wallet_address, price_usdc, route_tiers_supported, reputation_score, is_active)
values (
  'paylabs-source-verifier-v1',
  'source_verification',
  '/api/paylabs/agent-services/source-verifier',
  '0x0000000000000000000000000000000000000000',
  0.0003,
  array['normal','advanced','premium'],
  1,
  true
)
on conflict (agent_id) do update set
  service_type = excluded.service_type,
  endpoint_url = excluded.endpoint_url,
  price_usdc = excluded.price_usdc,
  route_tiers_supported = excluded.route_tiers_supported,
  is_active = excluded.is_active;
