-- Paylabs schema — prefixed tables to avoid collision with ArcLayer
-- Run via: npm run db:migrate

create extension if not exists pgcrypto;

-- ============================================================
-- 1. USERS
-- ============================================================
create table if not exists paylabs_users (
  id uuid primary key default gen_random_uuid(),
  wallet_address text unique not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. AUTH NONCES
-- ============================================================
create table if not exists paylabs_auth_nonces (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  nonce text not null,
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 3. SUPPORTED SITES
-- ============================================================
create table if not exists paylabs_supported_sites (
  id text primary key,
  name text not null,
  hosts text[] not null,
  enabled boolean not null default true,
  publish_target boolean not null default false,
  config_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

INSERT INTO paylabs_supported_sites (id, name, hosts, enabled, publish_target)
VALUES
  ('arc-community', 'Arc Community', ARRAY['community.arc.io', 'community.arc.network'], true, true),
  ('sepiasearch', 'SepiaSearch', ARRAY['sepiasearch.org'], true, false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 4. CONTENT ITEMS
-- ============================================================
create table if not exists paylabs_content_items (
  id text primary key,
  site_id text not null references paylabs_supported_sites(id),
  host text not null,
  content_url text not null,
  target_url text not null,
  content_type text not null check (content_type in ('arc_content', 'peertube_video')),
  title text,
  price_usdc numeric(18, 6) not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 5. SETTLEMENT BATCHES
-- ============================================================
create table if not exists paylabs_settlement_batches (
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

-- ============================================================
-- 6. PAYMENT ATTEMPTS
-- ============================================================
create table if not exists paylabs_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references paylabs_users(id),
  wallet_address text not null,
  site_id text not null references paylabs_supported_sites(id),
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
  batch_id uuid references paylabs_settlement_batches(id),
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

-- ============================================================
-- 7. ACCESS PASSES
-- ============================================================
create table if not exists paylabs_access_passes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references paylabs_users(id),
  wallet_address text not null,
  content_id text not null references paylabs_content_items(id),
  site_id text not null references paylabs_supported_sites(id),
  target_url text not null,
  payment_attempt_id uuid not null references paylabs_payment_attempts(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, content_id)
);

-- ============================================================
-- 8. RECEIPTS
-- ============================================================
create table if not exists paylabs_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references paylabs_users(id),
  payment_attempt_id uuid not null references paylabs_payment_attempts(id),
  batch_id uuid references paylabs_settlement_batches(id),
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

-- ============================================================
-- 9. AI REQUESTS
-- ============================================================
create table if not exists paylabs_ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references paylabs_users(id),
  wallet_address text not null,
  site_id text not null references paylabs_supported_sites(id),
  query text not null,
  price_usdc numeric(18, 6) not null,
  payment_attempt_id uuid references paylabs_payment_attempts(id),
  status text not null check (status in ('payment_required', 'paid', 'searching', 'answered', 'failed')),
  answer_text text,
  sources_json jsonb,
  agent_decision_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

-- ============================================================
-- 10. INDEXES
-- ============================================================
create index if not exists idx_paylabs_users_wallet on paylabs_users(wallet_address);
create index if not exists idx_paylabs_auth_nonces_wallet on paylabs_auth_nonces(wallet_address, used);
create index if not exists idx_paylabs_payment_attempts_user on paylabs_payment_attempts(user_id, status);
create index if not exists idx_paylabs_payment_attempts_batch on paylabs_payment_attempts(batch_id);
create index if not exists idx_paylabs_receipts_user on paylabs_receipts(user_id);
create index if not exists idx_paylabs_access_passes_user on paylabs_access_passes(user_id, content_id);
create index if not exists idx_paylabs_settlement_batches_status on paylabs_settlement_batches(status);
