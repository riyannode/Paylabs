#!/usr/bin/env python3
"""Run all 20 Brain-only debug tests against the live preview."""
import json, subprocess, sys

BASE = "https://paylabs-git-feat-rsshub-live-d-6d06c3-cutepelong-8844s-projects.vercel.app"
ENDPOINT = f"{BASE}/api/paylabs/debug/brain-plan"

TESTS = [
    ("latest npm langchain package update", "easy"),
    ("newest @langchain/core release notes", "easy"),
    ("latest Next.js release update", "easy"),
    ("what is x402 payment protocol", "easy"),
    ("find latest RSSHub GitHub route update", "easy"),
    ("latest OpenAI Codex GitHub release", "easy"),
    ("explain Circle Gateway balance in simple terms", "easy"),
    ("valid ga claim README repo ini", "normal"),
    ("compare LangChain vs CrewAI for agent orchestration", "normal"),
    ("is this x402 implementation production ready", "normal"),
    ("verify whether a GitHub repo actually uses Circle x402", "normal"),
    ("compare RSSHub live source discovery vs Tavily fallback", "normal"),
    ("check if npm package release claim is real", "normal"),
    ("assess trust quality of sources about OpenAI Codex", "normal"),
    ("pay creator and return receipt for source access", "advanced"),
    ("buy access to a paid source and show settlement receipt", "advanced"),
    ("route payment to source owner after verification", "advanced"),
    ("unlock premium article and record payment proof", "advanced"),
    ("pay author if source is verified and save receipt", "advanced"),
    ("settle creator payment after source access", "advanced"),
]

results = []
for i, (goal, expected) in enumerate(TESTS):
    payload = json.dumps({"userGoal": goal, "routeTier": "auto"})
    cmd = [
        "curl", "-s", "--max-time", "180", "-X", "POST", ENDPOINT,
        "-H", "Content-Type: application/json",
        "-d", payload,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        data = json.loads(result.stdout)
        ok = data.get("ok", False)
        hint = data.get("route_tier_hint", "none")
        hint_valid = data.get("route_tier_hint_valid", False)
        mc = data.get("selected_macro_nodes_count", 0)
        sc = data.get("selected_services_count", 0)
        err = data.get("errorClass", None)
        passed = ok and hint_valid and hint == expected
        status = "PASS" if passed else "FAIL"
        results.append((i+1, goal[:50], expected, hint, ok, mc, sc, status, err))
        print(f"  {i+1:2d}. [{status}] expected={expected:8s} got={hint:8s} ok={str(ok):5s} nodes={mc} svc={sc} err={str(err)[:50] if err else 'none'}")
    except Exception as e:
        results.append((i+1, goal[:50], expected, "error", False, 0, 0, "ERR", str(e)[:80]))
        print(f"  {i+1:2d}. [ERR] {e}")

# Summary
passed = sum(1 for r in results if r[7] == "PASS")
failed = sum(1 for r in results if r[7] != "PASS")
print(f"\n=== SUMMARY: {passed}/20 passed, {failed} failed ===")

# Check for forbidden values
for r in results:
    if r[3] in ("auto", "none", "", None):
        print(f"  !! FORBIDDEN VALUE: test {r[0]} got '{r[3]}'")
