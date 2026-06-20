-- Migration 6: Extend nanopayment status constraint
-- Adds 'running' and 'config_error' to allowed status values.
-- 'running' = withPaidNode() has started executing the node.
-- 'config_error' = createAgentContext() failed (e.g. missing HMAC secret).

alter table paylabs_agent_nanopayments
  drop constraint if exists paylabs_agent_nanopayments_status_check;

alter table paylabs_agent_nanopayments
  add constraint paylabs_agent_nanopayments_status_check
  check (status in (
    'planned', 'running', 'quoted', 'authorized',
    'completed', 'settlement_pending', 'paid',
    'failed', 'skipped', 'config_error'
  ));
