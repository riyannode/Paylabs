#!/usr/bin/env bash
# Push MiMo LLM env vars to Vercel (production + preview)
# Run: bash scripts/set-vercel-mimo.mjs
# Requires: vercel CLI logged in

set -euo pipefail
cd "$(dirname "$0")/.."

# Active MiMo keys (key 1 quota exhausted, skip)
KEYS=(
  "tp-syzzm862qict6lrwxkketwrlwx9jqlof7kpmi55zmcqdbhlo"
  "tp-scma1o6cvjsg7zor17bcfznc9i45cgfs5ecodjgvyacsdrv8"
  "tp-s6bp07v3jzb2vgvk8wuxc0k1hvlbqafk7kd4qixdvteqmsyb"
  "tp-s61jvt7sb4sr3q4rw6h1qae7ikmpztziv2auv0vei24uywfp"
  "tp-svj2dp9xx32ttdg0ewu0rpbtgftz0z4uva93uw8ageraoqyk"
  "tp-sdqx6btnnd1gk8iabqozae5nx4n4cppkpxllvol0w4f9layc"
  "tp-s4rcvsvkxun7vij6y3c4od9n2z95q24smt812s3wao1ctgb2"
  "tp-stlisfuovc85wt6efzk1xgxf0rwy7f06q4n116xi1w7bptua"
)

# Agent → key index mapping (2 agents per key, last gets 1)
declare -A AGENT_KEY_IDX=(
  [TUTOR_INTAKE]=0
  [INTENT_CLASSIFIER]=0
  [QUERY_EXPANDER]=1
  [FEED_DISCOVERY]=1
  [SOURCE_RANKER]=2
  [EVIDENCE_ALLOCATOR]=2
  [STOP_LIMIT]=3
  [BUDGET_OPTIMIZER]=3
  [SOURCE_QUALITY]=4
  [PROVENANCE]=4
  [CREATOR_OWNERSHIP]=5
  [POLICY_GUARD]=5
  [PAYMENT_QUOTE]=6
  [PAYMENT_EXECUTOR]=6
  [RECEIPT_AUDITOR]=7
)

echo "Setting MiMo LLM base URL and model..."
echo "https://token-plan-sgp.xiaomimimo.com/v1" | vercel env add PAYLABS_LLM_BASE_URL_DEFAULT production preview --yes 2>&1 || true
echo "mimo-v2.5-pro" | vercel env add PAYLABS_TUTOR_MODEL_DEFAULT production preview --yes 2>&1 || true
echo "true" | vercel env add PAYLABS_LLM_REQUIRED production preview --yes 2>&1 || true

echo ""
echo "Setting per-agent API keys..."
for agent_key in "${!AGENT_KEY_IDX[@]}"; do
  idx=${AGENT_KEY_IDX[$agent_key]}
  api_key="${KEYS[$idx]}"
  masked="${api_key:0:10}...${api_key: -4}"
  echo "  PAYLABS_LLM_API_KEY_${agent_key} = ${masked}"
  echo "$api_key" | vercel env add "PAYLABS_LLM_API_KEY_${agent_key}" production preview --yes 2>&1 || true
done

echo ""
echo "Done. Redeploy with: vercel --prod"
