#!/usr/bin/env bash
set -euo pipefail

cd /root/Paylabs

if [ ! -f .env.local ]; then
  echo "[worker-start] ERROR: missing .env.local"
  exit 1
fi

set -a
source .env.local
set +a

# Safe env presence check — never echo actual values
echo "[worker-start] env loaded:"
echo "  provider=${PAYLABS_LLM_PROVIDER_DEFAULT:-unset}"
echo "  timeout=${PAYLABS_LLM_TIMEOUT_MS:-unset}"
echo "  max_tokens=${PAYLABS_LLM_MAX_TOKENS:-unset}"
echo "  max_attempts=${PAYLABS_LLM_MAX_ATTEMPTS:-unset}"
echo "  llm_key_default=$([ -n "${PAYLABS_LLM_API_KEY_DEFAULT:-}" ] && echo present || echo empty)"
echo "  llm_key_per_agent=$([ -n "${PAYLABS_LLM_API_KEY_TUTOR_INTAKE:-}" ] && echo present || echo missing)"
echo "  supabase=$([ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && echo present || echo missing)"
echo "  app_url=${NEXT_PUBLIC_PAYLABS_APP_URL:-unset}"

exec pnpm worker:discovery
