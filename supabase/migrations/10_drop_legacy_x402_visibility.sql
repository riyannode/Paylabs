-- 10_drop_legacy_x402_visibility.sql
-- Drops legacy nanopayment/batch settlement tables after all code references removed.

drop table if exists paylabs_agent_batch_settlements cascade;
drop table if exists paylabs_agent_nanopayments cascade;
