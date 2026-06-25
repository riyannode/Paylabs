import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

base_url = "https://token-plan-sgp.xiaomimimo.com/v1"
api_key = "tp-s7w70rvu95654v230iz8gzzmoqgcun292fjm79n8w8hlsmml"

# Use --value flag instead of stdin
for env_name, env_value in [("PAYLABS_LLM_BASE_URL_DEFAULT", base_url), ("PAYLABS_LLM_API_KEY_DEFAULT", api_key)]:
    proc = subprocess.Popen(
        ["vercel", "env", "add", env_name, "preview", branch, "--token=" + token, "--value", env_value],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd="/root/Paylabs", text=True
    )
    out, _ = proc.communicate()
    print(f"{env_name}: {out.strip()[:150]}")
