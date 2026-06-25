import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']

# MiMo Token Plan config
base_url = "https://token-plan-sgp.xiaomimimo.com/v1"
api_key = "tp-s7w70rvu95654v230iz8gzzmoqgcun292fjm79n8w8hlsmml"
branch = "feat/rsshub-live-discovery-v3"

vars_to_update = [
    ("PAYLABS_LLM_BASE_URL_DEFAULT", base_url),
    ("PAYLABS_LLM_API_KEY_DEFAULT", api_key),
]

for env_name, env_value in vars_to_update:
    # Remove existing
    proc = subprocess.Popen(
        ["vercel", "env", "rm", env_name, "preview", branch, "--token=" + token, "--yes"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd="/root/Paylabs", text=True
    )
    out, _ = proc.communicate()
    print(f"Remove {env_name}: {out.strip()[:100]}")

    # Re-add with correct value
    proc2 = subprocess.Popen(
        ["vercel", "env", "add", env_name, "preview", branch, "--token=" + token],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd="/root/Paylabs", text=True
    )
    out2, _ = proc2.communicate(input=env_value + "\n")
    print(f"Add {env_name}: {out2.strip()[:100]}")

print("\nDone. Triggering redeploy...")
