-- Route toll payment records
-- Stores completed route toll proofs server-side so propose endpoints
-- can verify proof validity from DB, not just trust client headers.

create table if not exists paylabs_route_toll_calls (
  id uuid primary key default gen_random_uuid(),
  user_wallet text not null,
  route_tier text not null check (route_tier in ('normal', 'advanced', 'premium')),
  route_label text not null,
  normalized_goal text not null,
  input_hash text not null,
  amount_usdc numeric not null,
  payment_id text not null,
  payment_ref text,
  settlement_ref text,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create unique index if not exists paylabs_route_toll_calls_payment_id_idx
  on paylabs_route_toll_calls(payment_id);

create index if not exists paylabs_route_toll_calls_lookup_idx
  on paylabs_route_toll_calls(user_wallet, route_tier, input_hash, status);
