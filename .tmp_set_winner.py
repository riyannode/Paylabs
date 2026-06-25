import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"
api_key = "tp-s61jvt7sb4sr3q4rw6h1qae7ikmpztziv2auv0vei24uywfp"

# Remove old key
proc_rm = subprocess.Popen(
    ["vercel", "env", "rm", "PAYLABS_LLM_API_KEY_DEFAULT", "preview", branch, "--token=" + token, "--yes"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_rm, _ = proc_rm.communicate()
print(f"RM: {out_rm.strip()[:100]}")

# Add working key
proc_add = subprocess.Popen(
    ["vercel", "env", "add", "PAYLABS_LLM_API_KEY_DEFAULT", "preview", branch, "--token=" + token, "--value", api_key],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_add, _ = proc_add.communicate()
print(f"ADD: {out_add.strip()[:150]}")
