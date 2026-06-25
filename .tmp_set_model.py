import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
branch = "feat/rsshub-live-discovery-v3"

# Set MiMo model name
model_name = "mimo-v2.5-flash"

proc_rm = subprocess.Popen(
    ["vercel", "env", "rm", "PAYLABS_TUTOR_MODEL_DEFAULT", "preview", branch, "--token=" + token, "--yes"],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out, _ = proc_rm.communicate()
print(f"RM: {out.strip()[:100]}")

proc_add = subprocess.Popen(
    ["vercel", "env", "add", "PAYLABS_TUTOR_MODEL_DEFAULT", "preview", branch, "--token=" + token, "--value", model_name],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out, _ = proc_add.communicate()
print(f"ADD: {out.strip()[:150]}")
