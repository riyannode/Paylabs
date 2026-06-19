-- PayLabs Live Schema - Lepton Agents Hackathon 2026
create extension if not exists pgcrypto;

create table if not exists paylabs_sources (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null unique,
  source_title text not null,
  publisher text not null,
  source_type text not null,
  fetched_at timestamptz not null default now(),
  normalized_sha256 text not null,
  excerpt text not null,
  license_note text,
  created_at timestamptz default now()
);

create table if not exists paylabs_creators (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  wallet_address text not null unique,
  profile_url text,
  is_verified boolean not null default false,
  verification_note text,
  created_at timestamptz default now()
);

create table if not exists paylabs_lessons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null,
  body_markdown text not null,
  source_id uuid references paylabs_sources(id),
  creator_id uuid references paylabs_creators(id),
  price_usdc numeric(18,6) not null,
  estimated_minutes int not null,
  difficulty text not null,
  tags text[] not null default '{}',
  content_sha256 text not null,
  is_published boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists paylabs_unlocks (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid references paylabs_lessons(id),
  user_wallet text not null,
  payment_id text not null unique,
  payment_rail text not null default 'x402-gateway',
  amount_usdc numeric(18,6) not null,
  payment_ref text not null,
  tx_hash text,
  gateway_settlement_ref text,
  payment_response_json jsonb,
  unlocked_at timestamptz not null default now()
);

create table if not exists paylabs_completions (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid references paylabs_lessons(id),
  user_wallet text not null,
  unlock_id uuid references paylabs_unlocks(id),
  proof_type text not null default 'self_attested',
  proof_hash text not null,
  completed_at timestamptz not null default now()
);

create table if not exists paylabs_payout_receipts (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid references paylabs_lessons(id),
  unlock_id uuid references paylabs_unlocks(id),
  creator_wallet text not null,
  platform_wallet text not null,
  treasury_wallet text not null,
  gross_amount_usdc numeric(18,6) not null,
  creator_amount_usdc numeric(18,6) not null,
  platform_amount_usdc numeric(18,6) not null,
  treasury_amount_usdc numeric(18,6) not null,
  payment_ref text not null,
  tx_hash text,
  created_at timestamptz default now()
);

create index if not exists idx_unlocks_user_lesson on paylabs_unlocks(user_wallet, lesson_id);
create index if not exists idx_payout_creator on paylabs_payout_receipts(creator_wallet);
create index if not exists idx_lessons_published on paylabs_lessons(is_published) where is_published = true;

alter table paylabs_sources enable row level security;
alter table paylabs_creators enable row level security;
alter table paylabs_lessons enable row level security;
alter table paylabs_unlocks enable row level security;
alter table paylabs_completions enable row level security;
alter table paylabs_payout_receipts enable row level security;
