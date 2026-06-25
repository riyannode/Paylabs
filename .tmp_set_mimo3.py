import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

base_url = "https://token-plan-sgp.xiaomimimo.com/v1"
api_key = "tp-s7w70rvu95654v230iz8gzzmoqgcun292fjm79n8w8hlsmml"

# First pull current preview env for this branch to see what we have
proc = subprocess.Popen(
    ["vercel", "env", "pull", ".env.check", "--environment=preview", f"--git-branch={branch}", "--token=" + token],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out, _ = proc.communicate()
print(f"Pull: {out.strip()[:200]}")

# Check what's in the pulled env
with open("/root/Paylabs/.env.check") as f:
    for line in f:
        line = line.strip()
        if "LLM_BASE_URL" in line or "LLM_API_KEY" in line or "LLM_PROVIDER" in line:
            k, v = line.split("=", 1)
            # Show key and value length only
            print(f"  {k}: len={len(v)} masked={v == '***'}")

# Now try remove + add with --force
for env_name, env_value in [("PAYLABS_LLM_BASE_URL_DEFAULT", base_url), ("PAYLABS_LLM_API_KEY_DEFAULT", api_key)]:
    # Remove
    proc_rm = subprocess.Popen(
        ["vercel", "env", "rm", env_name, "preview", branch, "--token=" + token, "--yes"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd="/root/Paylabs", text=True
    )
    out_rm, _ = proc_rm.communicate()
    print(f"RM {env_name}: {out_rm.strip()[:100]}")

    # Add with --force
    proc_add = subprocess.Popen(
        ["vercel", "env", "add", env_name, "preview", branch, "--token=" + token, "--value", env_value, "--force"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd="/root/Paylabs", text=True
    )
    out_add, _ = proc_add.communicate()
    print(f"ADD {env_name}: {out_add.strip()[:150]}")
