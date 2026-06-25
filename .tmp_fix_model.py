import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

# Use mimo-v2.5-pro (recommended)
model_name = "mimo-v2.5-pro"

# Remove old
proc_rm = subprocess.Popen(
    ["vercel", "env", "rm", "PAYLABS_TUTOR_MODEL_DEFAULT", "preview", branch, "--token=" + token, "--yes"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_rm, _ = proc_rm.communicate()
print(f"RM: {out_rm.strip()[:100]}")

# Add correct model
proc_add = subprocess.Popen(
    ["vercel", "env", "add", "PAYLABS_TUTOR_MODEL_DEFAULT", "preview", branch, "--token=" + token, "--value", model_name],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out_add, _ = proc_add.communicate()
print(f"ADD: {out_add.strip()[:150]}")
