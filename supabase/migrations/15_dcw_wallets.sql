-- Migration 15: DCW Wallet Registry
-- Maps user email → Circle Developer-Controlled Wallet (DCW).
-- DCW wallets are custodial: Circle holds keys, app signs x402 server-side.

create table if not exists paylabs_dcw_wallets (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  wallet_id     text not null unique,   -- Circle DCW wallet ID
  wallet_address text not null,         -- 0x EVM address
  wallet_set_id text,                   -- Circle wallet set ID
  chain         text not null default 'ARC-TESTNET',
  account_type  text not null default 'EOA'
                check (account_type in ('EOA', 'SCA')),
  status        text not null default 'active'
                check (status in ('active', 'suspended', 'closed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Index: look up wallet by email (case-insensitive)
create index if not exists idx_dcw_wallets_email
  on paylabs_dcw_wallets (lower(email));

-- Index: look up by wallet_id
create index if not exists idx_dcw_wallets_wallet_id
  on paylabs_dcw_wallets (wallet_id);

-- Index: look up by address
create index if not exists idx_dcw_wallets_address
  on paylabs_dcw_wallets (lower(wallet_address));

-- updated_at trigger
create or replace function update_dcw_wallets_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_dcw_wallets_updated_at
  before update on paylabs_dcw_wallets
  for each row execute function update_dcw_wallets_updated_at();
