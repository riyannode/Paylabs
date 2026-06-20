#!/usr/bin/env bash
# PayLabs Discovery Worker — Safe Restart Script
#
# Usage:
#   ./scripts/restart-worker.sh          # restart worker only
#   ./scripts/restart-worker.sh status   # show status
#   ./scripts/restart-worker.sh logs     # tail logs
#   ./scripts/restart-worker.sh verify   # full health check
#
# Never uses `pm2 restart --update-env` (doesn't reload .env.local)

set -euo pipefail
cd /root/Paylabs

CMD="${1:-restart}"

case "$CMD" in
  status)
    pm2 status paylabs-discovery-worker
    ;;

  logs)
    pm2 logs paylabs-discovery-worker --lines "${2:-50}" --nostream
    ;;

  verify)
    echo "=== PM2 Status ==="
    pm2 status paylabs-discovery-worker 2>&1 | grep paylabs
    echo ""
    echo "=== Env Presence ==="
    pm2 env "$(pm2 id paylabs-discovery-worker | head -1)" 2>/dev/null | grep -E \
      "PAYLABS_LLM_PROVIDER_DEFAULT|PAYLABS_LLM_TIMEOUT_MS|PAYLABS_LLM_MAX_TOKENS|PAYLABS_LLM_MAX_ATTEMPTS|SUPABASE_URL" \
      | sed 's/=.*$/=<set>/' || echo "(use start script to see full env)"
    echo ""
    echo "=== Recent Logs ==="
    pm2 logs paylabs-discovery-worker --lines 8 --nostream 2>&1 | grep -E "worker-start|worker.*started|Polling|Claimed|completed|failed" | tail -8
    ;;

  restart|stop-start)
    echo "[restart] Stopping worker..."
    pm2 delete paylabs-discovery-worker 2>/dev/null || true
    echo "[restart] Starting via ecosystem config..."
    cd /root/Paylabs
    pm2 start ecosystem.config.cjs --only paylabs-discovery-worker
    pm2 save --force
    sleep 5
    echo "[restart] Status:"
    pm2 status paylabs-discovery-worker 2>&1 | grep paylabs
    echo "[restart] Startup logs:"
    pm2 logs paylabs-discovery-worker --lines 12 --nostream 2>&1 | grep -E "worker-start|env loaded|provider=|llm_key|worker.*started|Polling" | tail -12
    ;;

  *)
    echo "Usage: $0 {status|logs|restart|verify} [lines]"
    exit 1
    ;;
esac
