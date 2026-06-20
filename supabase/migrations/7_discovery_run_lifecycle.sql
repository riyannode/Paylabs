-- Migration 7: Discovery Run Lifecycle Fields
-- Adds async worker lifecycle tracking for background pipeline execution.
-- Required for: enqueue → worker claim → run → complete/fail pattern.

-- Extend allowed statuses
alter table paylabs_discovery_runs
  drop constraint if exists paylabs_discovery_runs_status_check;

alter table paylabs_discovery_runs
  add constraint paylabs_discovery_runs_status_check
  check (status in (
    'queued',
    'running',
    'completed',
    'failed',
    'timed_out',
    'discovery_only',
    'paid_path_available'
  ));

-- Lifecycle timestamps
alter table paylabs_discovery_runs add column if not exists queued_at timestamptz;
alter table paylabs_discovery_runs add column if not exists started_at timestamptz;
alter table paylabs_discovery_runs add column if not exists completed_at timestamptz;

-- Worker tracking
alter table paylabs_discovery_runs add column if not exists runner_id text;
alter table paylabs_discovery_runs add column if not exists current_agent text;
alter table paylabs_discovery_runs add column if not exists worker_heartbeat_at timestamptz;

-- Error tracking
alter table paylabs_discovery_runs add column if not exists error_summary text;

-- Index for worker polling: find queued runs oldest-first
create index if not exists idx_discovery_runs_queued
  on paylabs_discovery_runs(status, queued_at asc)
  where status = 'queued';

-- Index for timeout detection: find stale running runs
create index if not exists idx_discovery_runs_running
  on paylabs_discovery_runs(status, worker_heartbeat_at)
  where status = 'running';

-- Hard duplicate guard: one row per (run, agent_name)
create unique index if not exists idx_paylabs_nanopayments_run_agent_unique
  on paylabs_agent_nanopayments(discovery_run_id, agent_name);
