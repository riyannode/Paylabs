-- Migration 29: Security Advisor RLS policy completion
--
-- Supabase advisor flags RLS-enabled tables with zero policies. These tables are
-- backend/service-role only; add explicit deny policies for anon/authenticated
-- and revoke exposed-role table privileges. Idempotent and guarded for existing
-- production drift.
--
-- Also fixes Security Advisor function warnings for the Mini Virtual Office
-- SECURITY DEFINER RPC and withdrawal updated_at trigger helper.

begin;

do $$
declare
  table_name text;
  table_names text[] := array[
    'paylabs_creator_claims',
    'paylabs_creator_memory',
    'paylabs_creator_payout_events',
    'paylabs_evaluator_memory',
    'paylabs_gateway_withdrawals',
    'paylabs_office_run_sequences',
    'paylabs_page_visits',
    'paylabs_payout_ledger',
    'paylabs_source_attributions',
    -- Guarded for older/newer production drift seen in advisors.
    'paylabs_creator_summary',
    'paylabs_user_optin_volumes'
  ];
begin
  foreach table_name in array table_names loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('revoke all on table public.%I from authenticated', table_name);

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'deny anon authenticated select'
    ) then
      execute format(
        'create policy "deny anon authenticated select" on public.%I for select to anon, authenticated using (false)',
        table_name
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'deny anon authenticated insert'
    ) then
      execute format(
        'create policy "deny anon authenticated insert" on public.%I for insert to anon, authenticated with check (false)',
        table_name
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'deny anon authenticated update'
    ) then
      execute format(
        'create policy "deny anon authenticated update" on public.%I for update to anon, authenticated using (false) with check (false)',
        table_name
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'deny anon authenticated delete'
    ) then
      execute format(
        'create policy "deny anon authenticated delete" on public.%I for delete to anon, authenticated using (false)',
        table_name
      );
    end if;
  end loop;
end $$;

ALTER FUNCTION public.emit_paylabs_office_event(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  uuid
)
SET search_path = pg_catalog, public;

REVOKE EXECUTE ON FUNCTION public.emit_paylabs_office_event(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.emit_paylabs_office_event(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb,
  uuid
) TO service_role;

ALTER FUNCTION public.update_withdrawals_updated_at()
SET search_path = pg_catalog, public;

REVOKE EXECUTE ON FUNCTION public.update_withdrawals_updated_at()
FROM PUBLIC, anon, authenticated;

commit;
