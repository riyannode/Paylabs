import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

# Try another key
api_key = "tp-syzzm862qict6lrwxkketwrlwx9jqlof7kpmi55zmcqdbhlo"

# Remove old
proc_rm = subprocess.Popen(
    ["vercel", "env", "rm", "PAYLABS_LLM_API_KEY_DEFAULT", "preview", branch, "--token=" + token, "--yes"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_rm, _ = proc_rm.communicate()
print(f"RM: {out_rm.strip()[:100]}")

# Add new key
proc_add = subprocess.Popen(
    ["vercel", "env", "add", "PAYLABS_LLM_API_KEY_DEFAULT", "preview", branch, "--token=" + token, "--value", api_key],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_add, _ = proc_add.communicate()
print(f"ADD: {out_add.strip()[:150]}")
