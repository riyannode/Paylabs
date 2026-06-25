#!/bin/bash
set -e

export VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/root/.vercel/auth.json'))['token'])")
cd /root/Paylabs

# Read values from dev env
PROVIDER=$(python3 -c "
lines = open('.env.vercel').readlines()
for l in lines:
    l = l.strip()
    if l.startswith('PAYLABS_LLM_PROVIDER_DEFAULT='):
        print(l.split('=',1)[1].strip('\"'))
")

BASE_URL=$(python3 -c "
lines = open('.env.vercel').readlines()
for l in lines:
    l = l.strip()
    if l.startswith('PAYLABS_LLM_BASE_URL_DEFAULT='):
        print(l.split('=',1)[1].strip('\"'))
")

API_KEY=$(python3 -c "
lines = open('.env.vercel').readlines()
for l in lines:
    l = l.strip()
    if l.startswith('PAYLABS_LLM_API_KEY_DEFAULT='):
        print(l.split('=',1)[1].strip('\"'))
")

echo "Provider: $PROVIDER"
echo "Base URL len: ${#BASE_URL}"
echo "API key len: ${#API_KEY}"

# Add each env var using vercel CLI for preview + this branch
echo "$PROVIDER" | vercel env add PAYLABS_LLM_PROVIDER_DEFAULT preview feat/rsshub-live-discovery-v3 --token="$VERCEL_TOKEN" 2>&1
echo "$BASE_URL" | vercel env add PAYLABS_LLM_BASE_URL_DEFAULT preview feat/rsshub-live-discovery-v3 --token="$VERCEL_TOKEN" 2>&1
echo "$API_KEY" | vercel env add PAYLABS_LLM_API_KEY_DEFAULT preview feat/rsshub-live-discovery-v3 --token="$VERCEL_TOKEN" 2>&1

echo "Done adding env vars"
