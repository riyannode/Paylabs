-- Source Discovery Metadata
-- Adds domain, trust_status, claim_status, ingested_at to paylabs_feed_items
-- Adds access_key_env to paylabs_rsshub_routes

-- ─── paylabs_feed_items: new columns ────────────────────────

alter table paylabs_feed_items add column if not exists domain text;
alter table paylabs_feed_items add column if not exists trust_status text not null default 'unverified'
  check (trust_status in ('verified', 'unverified', 'suspicious', 'disputed'));
alter table paylabs_feed_items add column if not exists claim_status text not null default 'unclaimed'
  check (claim_status in ('claimed', 'unclaimed', 'disputed'));
alter table paylabs_feed_items add column if not exists ingested_at timestamptz not null default now();

-- ─── paylabs_rsshub_routes: access_key_env ──────────────────

alter table paylabs_rsshub_routes add column if not exists access_key_env text;

-- ─── Indexes ────────────────────────────────────────────────

create index if not exists idx_feed_items_domain on paylabs_feed_items(domain);
create index if not exists idx_feed_items_trust_status on paylabs_feed_items(trust_status);
create index if not exists idx_feed_items_claim_status on paylabs_feed_items(claim_status);
