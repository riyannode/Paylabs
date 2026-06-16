create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  wallet_address text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists auth_nonces (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  nonce text not null,
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists supported_sites (
  id text primary key,
  name text not null,
  hosts text[] not null,
  enabled boolean not null default true,
  publish_target boolean not null default false,
  config_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into supported_sites (id, name, hosts, enabled, publish_target)
values
  ('arc-community', 'Arc Community', array['community.arc.io','community.arc.network'], true, true),
  ('sepiasearch', 'SepiaSearch', array['sepiasearch.org'], true, false)
on conflict (id) do nothing;

create table if not exists content_items (
  id text primary key,
  site_id text not null references supported_sites(id),
  host text not null,
  content_url text not null,
  target_url text not null,
  content_type text not null check (content_type in ('arc_content', 'peertube_video')),
  title text,
  price_usdc numeric(18, 6) not null,
  created_at timestamptz not null default now()
);

create table if not exists settlement_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('open', 'closed', 'settlement_pending', 'settled', 'failed')) default 'open',
  threshold_count integer not null default 5,
  current_count integer not null default 0,
  settlement_ref text,
  tx_hash text,
  explorer_url text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  settled_at timestamptz,
  error text
);

create table if not exists payment_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  wallet_address text not null,
  site_id text not null references supported_sites(id),
  purpose text not null check (purpose in ('ai_search', 'content_access')),
  resource_id text not null,
  amount_usdc numeric(18, 6) not null,
  status text not null check (status in ('required', 'submitted', 'accepted', 'failed', 'settlement_pending', 'settled')),
  payment_requirement_json jsonb,
  x402_payload_json jsonb,
  facilitator_receipt_json jsonb,
  payment_id text,
  authorization_hash text,
  settlement_ref text,
  batch_id uuid references settlement_batches(id),
  batch_position integer,
  tx_hash text,
  explorer_url text,
  idempotency_key text unique not null,
  error text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  accepted_at timestamptz,
  settled_at timestamptz
);

create table if not exists access_passes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  wallet_address text not null,
  content_id text not null references content_items(id),
  site_id text not null references supported_sites(id),
  target_url text not null,
  payment_attempt_id uuid not null references payment_attempts(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, content_id)
);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  payment_attempt_id uuid not null references payment_attempts(id),
  batch_id uuid references settlement_batches(id),
  batch_position integer,
  batch_status text,
  site_id text not null,
  purpose text not null,
  title text not null,
  amount_usdc numeric(18, 6) not null,
  payment_id text,
  authorization_hash text,
  settlement_ref text,
  tx_hash text,
  explorer_url text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  wallet_address text not null,
  site_id text not null references supported_sites(id),
  query text not null,
  price_usdc numeric(18, 6) not null,
  payment_attempt_id uuid references payment_attempts(id),
  status text not null check (status in ('payment_required', 'paid', 'searching', 'answered', 'failed')),
  answer_text text,
  sources_json jsonb,
  agent_decision_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
