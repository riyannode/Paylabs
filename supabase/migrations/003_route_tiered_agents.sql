-- Migration 003: Route-Tiered Agent Workflows
-- Adds route_tier, route_config, and agent_trace columns to paylabs_learning_paths.
-- Route tiers: normal (max 2 lessons), advanced (max 5), premium (max 8).
-- All tiers share the same policy guard and Runner payment executor.

alter table paylabs_learning_paths add column if not exists route_tier text not null default 'normal' check (route_tier in ('normal', 'advanced', 'premium'));
alter table paylabs_learning_paths add column if not exists route_config jsonb not null default '{}'::jsonb;
alter table paylabs_learning_paths add column if not exists agent_trace jsonb not null default '{}'::jsonb;

create index if not exists idx_paths_route_tier on paylabs_learning_paths(route_tier);
