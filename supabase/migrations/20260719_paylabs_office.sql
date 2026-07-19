-- PayLabs Mini Virtual Office event stream.
-- Runtime events are best-effort visualization data only. They do not authorize,
-- sign, settle, or account for x402 payments.

create table if not exists public.paylabs_office_run_sequences (
  run_id text primary key,
  last_sequence bigint not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.next_paylabs_office_sequence(
  p_run_id text
)
returns bigint
language plpgsql
security definer
as $$
declare
  v_sequence bigint;
begin
  insert into public.paylabs_office_run_sequences(run_id, last_sequence)
  values (p_run_id, 1)
  on conflict (run_id)
  do update set
    last_sequence = public.paylabs_office_run_sequences.last_sequence + 1,
    updated_at = now()
  returning last_sequence into v_sequence;

  return v_sequence;
end;
$$;

create table if not exists public.paylabs_office_events (
  id uuid primary key,
  run_id text not null,
  sequence bigint not null,
  event_type text not null,
  agent_id text,
  phase text,
  status text,
  title text not null,
  message text,
  payment jsonb,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique(run_id, sequence)
);

create index if not exists paylabs_office_events_run_sequence_idx
on public.paylabs_office_events(run_id, sequence);

alter table public.paylabs_office_events enable row level security;
alter table public.paylabs_office_run_sequences enable row level security;

-- MVP consistency: paylabs_discovery_runs is currently public-readable
-- (see migration 3_discovery_runs.sql). Office events follow that model for now.
-- TODO: restrict office event reads using the same authenticated wallet ownership
-- model once PayLabs has wallet-bound RLS on paylabs_discovery_runs.user_wallet.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'paylabs_office_events'
      and policyname = 'public_read_paylabs_office_events'
  ) then
    create policy "public_read_paylabs_office_events"
      on public.paylabs_office_events
      for select
      using (true);
  end if;
end $$;

-- Writes use the server-side Supabase service role only. Do not add public write policies.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'paylabs_office_events'
     ) then
    alter publication supabase_realtime add table public.paylabs_office_events;
  end if;
exception
  when undefined_object then
    null;
end $$;
