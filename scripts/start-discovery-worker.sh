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
# Check all paid agent LLM keys — present/missing only, never echo values
PAID_AGENTS="TUTOR_INTAKE INTENT_CLASSIFIER QUERY_EXPANDER SOURCE_RANKER SOURCE_QUALITY PROVENANCE CREATOR_OWNERSHIP"
echo "  llm_key_default=$([ -n "${PAYLABS_LLM_API_KEY_DEFAULT:-}" ] && echo present || echo empty)"
missing=0
for agent in $PAID_AGENTS; do
  var="PAYLABS_LLM_API_KEY_${agent}"
  val="${!var:-}"
  if [ -z "$val" ]; then
    echo "  llm_key_${agent}=MISSING"
    missing=$((missing + 1))
  else
    echo "  llm_key_${agent}=present"
  fi
done
if [ "$missing" -gt 0 ]; then
  echo "[worker-start] WARNING: $missing paid agent key(s) missing"
fi
echo "  supabase=$([ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] && echo present || echo missing)"
echo "  app_url=${NEXT_PUBLIC_PAYLABS_APP_URL:-unset}"

exec pnpm worker:discovery
