#!/bin/bash
set -e
export VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/root/.vercel/auth.json'))['token'])")
cd /root/Paylabs
vercel deploy --token="$VERCEL_TOKEN" --yes 2>&1 | tail -5
