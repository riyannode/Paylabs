-- PayLabs Migration: Add nonce_hash for duplicate guard on agent nanopayments
-- Prevents replay attacks even if Gateway also rejects them.
-- nonce_hash = "from:nonce" extracted from x402 payment payload.

alter table paylabs_agent_nanopayments
  add column if not exists nonce_hash text;

create unique index if not exists idx_nanopayments_nonce
  on paylabs_agent_nanopayments(nonce_hash)
  where nonce_hash is not null;
