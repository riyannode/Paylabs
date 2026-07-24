-- Aggregate Explorer monetary totals directly in PostgreSQL.
-- Read-only function: does not insert, update, or delete application data.

create or replace function public.get_paylabs_explorer_totals()
returns table (
  total_settled_usdc numeric,
  creator_paid_usdc numeric,
  treasury_unallocated_usdc numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  select
    coalesce(
      (
        select sum(r.actual_settled_usdc)
        from public.paylabs_receipts as r
      ),
      0::numeric
    ) as total_settled_usdc,

    coalesce(
      (
        select sum(p.amount_usdc)
        from public.paylabs_payout_ledger as p
        where p.payout_type = 'creator_share'
          and p.status in ('paid', 'gateway_accepted')
      ),
      0::numeric
    ) as creator_paid_usdc,

    coalesce(
      (
        select sum(p.amount_usdc)
        from public.paylabs_payout_ledger as p
        where (
          p.payout_type = 'unallocated_reserve'
          and p.status = 'skipped'
        )
        or p.payout_type = 'treasury_retained'
      ),
      0::numeric
    ) as treasury_unallocated_usdc;
$function$;

revoke all
on function public.get_paylabs_explorer_totals()
from public;

revoke all
on function public.get_paylabs_explorer_totals()
from anon;

revoke all
on function public.get_paylabs_explorer_totals()
from authenticated;

grant execute
on function public.get_paylabs_explorer_totals()
to service_role;

comment on function public.get_paylabs_explorer_totals()
is 'Returns aggregate monetary totals for the PayLabs Explorer without row limits.';
