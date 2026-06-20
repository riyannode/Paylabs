# PayLabs Discovery Worker — PM2 Operations

## Critical Pitfall

**`pm2 restart --update-env` does NOT reload `.env.local`.**

The worker will start with zero API keys, zero Supabase config, and fall back to defaults.
Every LLM call will timeout at 180s. The pipeline will fail on the first agent.

Always start/restart the worker through `scripts/start-discovery-worker.sh`.

## Start / Restart Commands

```bash
# Preferred: use restart script
bash scripts/restart-worker.sh restart

# Or manually via ecosystem config
pm2 delete paylabs-discovery-worker || true
pm2 start ecosystem.config.cjs --only paylabs-discovery-worker
pm2 save --force
```

**The ecosystem config (`ecosystem.config.cjs`) loads `.env.local` at parse time.**
This solves the `pm2 restart --update-env` bug — env is always fresh.

**Never use:**
```bash
# WRONG — does not reload .env.local
pm2 restart paylabs-discovery-worker --update-env
```

## Crash Resilience

| Setting | Value | Purpose |
|---------|-------|---------|
| `autorestart` | `true` | Auto-restart on crash |
| `max_restarts` | `100` | Keep trying |
| `min_uptime` | `10s` | Crash if exits within 10s |
| `exp_backoff_restart_delay` | `5000` | 5s → 10s → 20s → 40s → ... |
| `max_memory_restart` | `512M` | Restart on memory leak |
| `kill_timeout` | `60s` | Graceful for in-flight LLM calls |

**Boot recovery:** PM2 systemd service (`pm2-root`) is `enabled`. On reboot:
1. systemd starts PM2
2. PM2 `resurrect` loads saved process list from `dump.pm2`
3. Worker starts via ecosystem config (`.env.local` loaded)

**Crash tested:** `kill -9` → PM2 restarts worker in ~3s.

## Safe Environment Checks

After starting, verify env is loaded:

```bash
pm2 logs paylabs-discovery-worker --lines 10 --nostream
```

Expected startup output:
```
[worker-start] env loaded:
  provider=mimo
  timeout=180000
  max_tokens=2048
  max_attempts=1
  llm_key=present
  supabase=present
  app_url=https://paylabs.vercel.app
[worker] Discovery worker started (runner_id: worker-...)
[worker] Polling every 5000ms
```

If `llm_key=missing` or `supabase=missing`, the worker will fail on every run.

## Required Environment Variables

| Variable | Example | Purpose |
|----------|---------|---------|
| `SUPABASE_URL` | `https://...supabase.co` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `...` | Supabase admin key |
| `PAYLABS_LLM_PROVIDER_DEFAULT` | `mimo` | LLM provider (NOT `openai` for MiMo) |
| `PAYLABS_LLM_API_KEY_DEFAULT` | `tp-s...` | Fallback LLM key |
| `PAYLABS_LLM_API_KEY_<AGENT>` | `tp-s...` | Per-agent LLM keys |
| `PAYLABS_LLM_BASE_URL_DEFAULT` | `https://token-plan-sgp.xiaomimimo.com/v1` | MiMo endpoint |
| `PAYLABS_LLM_TIMEOUT_MS` | `180000` | Per-call timeout (ms) |
| `PAYLABS_LLM_MAX_TOKENS` | `2048` | Max tokens per call (includes reasoning) |
| `PAYLABS_LLM_MAX_ATTEMPTS` | `1` | Retry attempts per agent |
| `PAYLABS_LLM_REQUIRED` | `true` | Fail pipeline if LLM unavailable |
| `PAYLABS_AGENT_CONTEXT_HMAC_SECRET` | `...` | Agent context signing |

## MiMo-Specific Notes

- `PAYLABS_LLM_PROVIDER_DEFAULT` must be `mimo`, NOT `openai`.
  - `openai` → code uses `withStructuredOutput()` which MiMo doesn't support.
  - `mimo` → code uses schema injection via `zod-to-json-schema` into system prompt.
- `PAYLABS_LLM_MAX_TOKENS` must be ≥ 2048.
  - MiMo uses reasoning_tokens that count against max_tokens.
  - With 1024, reasoning consumes all tokens → empty content → timeout.
  - With 2048, reasoning uses ~600 tokens, content gets ~40 tokens.
- `PAYLABS_LLM_MAX_ATTEMPTS=1` is recommended for MiMo.
  - MiMo timeouts should not retry (same key, same result).
  - Set `PAYLABS_LLM_RETRY_TIMEOUTS=true` only if keys are rotating.

## Worker Lifecycle

1. Worker polls `paylabs_discovery_runs` for `status='queued'` every 5s.
2. Claims one run: updates `status='running'`, sets `runner_id`.
3. Executes 7 agents sequentially:
   - `tutor_intake` → intent classification
   - `intent_classifier` → detailed intent
   - `query_expander` → search queries
   - `discovery_ranker` → feed scanning
   - `source_quality_verifier` → quality check
   - `provenance_verifier` → provenance check
   - `attribution_auditor` → attribution audit
4. `budget_optimizer` is deterministic (no LLM call, instant).
5. Updates `paylabs_agent_nanopayments` per agent: planned → running → completed/failed.
6. Final status: `completed` / `discovery_only` / `failed` / `timed_out`.

## Monitoring

```bash
# Worker status
pm2 status paylabs-discovery-worker

# Recent logs
pm2 logs paylabs-discovery-worker --lines 50 --nostream

# Check specific run (via Supabase REST)
curl -sS 
```

## Log Safety

- Never echo API keys, Supabase keys, HMAC secrets, or base URLs.
- Debug logs (when `PAYLABS_LLM_DEBUG=true`) show: provider, model, agent_name, mode, attempt, expected_keys, received_keys, content_length.
- No content_preview, no full prompt, no full response in production logs.
