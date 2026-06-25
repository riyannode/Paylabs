#!/usr/bin/env python3
"""Run full DCW/x402 Easy test via API with session cookie."""
import json, subprocess, sys

BASE = "https://paylabs-git-feat-rsshub-live-d-6d06c3-cutepelong-8844s-projects.vercel.app"

# Read session cookie
cookie_value = None
with open("/tmp/dcw_cookies.txt") as f:
    for line in f:
        if "paylabs_dcw_session" in line:
            cookie_value = line.strip().split()[-1]
            break

if not cookie_value:
    print("ERROR: No session cookie found"); sys.exit(1)

print(f"Cookie: present (len={len(cookie_value)})")

# Run Easy test via inline route
payload = json.dumps({
    "goal": "latest npm langchain package update",
    "route_tier": "auto",
    "budget_usdc": 0.01,
    "user_wallet": "0x55021650dc3871be72398f6faaf8f8d8f3d00e8d",
})

cmd = [
    "curl", "-s", "--max-time", "300", "-X", "POST",
    f"{BASE}/api/paylabs/discovery-runs/inline",
    "-H", "Content-Type: application/json",
    "-H", f"Cookie: paylabs_dcw_session={cookie_value}",
    "-d", payload,
]

print("Running Easy test via inline route...")
result = subprocess.run(cmd, capture_output=True, text=True)
try:
    data = json.loads(result.stdout)
    # Safe fields only
    print(f"Status: {data.get('status', 'unknown')}")
    print(f"Route tier: {data.get('routeTier', 'unknown')}")
    print(f"final_answer exists: {bool(data.get('final_answer'))}")
    print(f"final_answer preview: {str(data.get('final_answer', ''))[:100]}")
    print(f"source_context.source_count: {data.get('source_context', {}).get('source_count', 'N/A')}")
    sources = data.get('source_context', {}).get('sources_used', [])
    print(f"sources_used count: {len(sources)}")
    for s in sources[:3]:
        print(f"  - {s.get('title', 'N/A')[:50]} | {s.get('domain', 'N/A')} | {s.get('source_kind', 'N/A')}")
    summaries = data.get('progress_summaries', [])
    print(f"progress_summaries count: {len(summaries)}")
    for s in summaries[:5]:
        print(f"  - {str(s)[:100]}")
    payment = data.get('payment_graph', [])
    paid = sum(1 for e in payment if e.get('status') == 'paid')
    print(f"payment_edges: {paid}/{len(payment)} paid")
    print(f"error: {data.get('error', 'none')}")
except Exception as e:
    print(f"Error parsing: {e}")
    print(f"Raw (first 500): {result.stdout[:500]}")
