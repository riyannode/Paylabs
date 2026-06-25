#!/bin/bash
set -e
export VERCEL_TOKEN=*** -c "import json; print(json.load(open('/root/.vercel/auth.json'))['token'])")
cd /root/Paylabs

# First remove existing empty PAYLABS_LLM_API_KEY_DEFAULT for this branch
vercel env rm PAYLABS_LLM_API_KEY_DEFAULT preview feat/rsshub-live-discovery-v3 --token="$VERCEL_TOKEN" --yes 2>&1 || echo "Remove failed (may not exist)"

# Re-add with "unused" placeholder (MiMo uses URL-based auth)
echo "unused" | vercel env add PAYLABS_LLM_API_KEY_DEFAULT preview feat/rsshub-live-discovery-v3 --token="$VERCEL_TOKEN" 2>&1

echo "Done"
