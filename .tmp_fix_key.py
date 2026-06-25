import json, subprocess, sys

token = json.load(open('/root/.vercel/auth.json'))['token']

# Step 1: Remove existing PAYLABS_LLM_API_KEY_DEFAULT for this branch
cmd_rm = [
    "vercel", "env", "rm", "PAYLABS_LLM_API_KEY_DEFAULT", 
    "preview", "feat/rsshub-live-discovery-v3",
    "--token=" + token, "--yes"
]
r1 = subprocess.run(cmd_rm, capture_output=True, text=True, cwd="/root/Paylabs")
print("Remove:", r1.stdout.strip() or r1.stderr.strip())

# Step 2: Re-add with "unused" placeholder
proc = subprocess.Popen(
    ["vercel", "env", "add", "PAYLABS_LLM_API_KEY_DEFAULT", 
     "preview", "feat/rsshub-live-discovery-v3", "--token=" + token],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    cwd="/root/Paylabs", text=True
)
out, _ = proc.communicate(input="unused\n")
print("Add:", out.strip())
