import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

# Check if PROVIDER is set
proc = subprocess.Popen(
    ["vercel", "env", "pull", ".env.check2", "--environment=preview", f"--git-branch={branch}", "--token=" + token],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
proc.communicate()

with open("/root/Paylabs/.env.check2") as f:
    for line in f:
        line = line.strip()
        if "LLM_PROVIDER" in line or "LLM_BASE_URL" in line or "LLM_API_KEY_DEFAULT" in line:
            k, v = line.split("=", 1)
            print(f"  {k}: len={len(v)} value_preview={v[:20] if len(v) > 2 else v}")

# Also check what provider the other agents use
with open("/root/Paylabs/.env.check2") as f:
    for line in f:
        line = line.strip()
        if "LLM_PROVIDER" in line:
            k, v = line.split("=", 1)
            print(f"  {k}: {v}")
