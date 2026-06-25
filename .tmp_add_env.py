import json, subprocess, sys

token = json.load(open('/root/.vercel/auth.json'))['token']

# Read dev env
env = {}
with open('/root/Paylabs/.env.vercel') as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k] = v

provider = env.get('PAYLABS_LLM_PROVIDER_DEFAULT', '').strip('"')
base_url = env.get('PAYLABS_LLM_BASE_URL_DEFAULT', '').strip('"')
api_key = env.get('PAYLABS_LLM_API_KEY_DEFAULT', '').strip('"')

project_id = "prj_AanepVpOWTukligeiZ1owmZXbzH1"
team_id = "cutepelong-8844s-projects"
branch = "feat/rsshub-live-discovery-v3"
auth = "Bearer " + token

# Try the POST /v9/env with 'target' as a string
vars_to_add = [
    ("PAYLABS_LLM_PROVIDER_DEFAULT", provider),
    ("PAYLABS_LLM_BASE_URL_DEFAULT", base_url),
    ("PAYLABS_LLM_API_KEY_DEFAULT", api_key),
]

for key, value in vars_to_add:
    payload = json.dumps({
        "key": key,
        "value": value,
        "target": "preview",
        "gitBranch": branch,
        "type": "encrypted",
    })
    
    cmd = [
        "curl", "-s", "-X", "POST",
        f"https://api.vercel.com/v9/env?projectId={project_id}&teamId={team_id}",
        "-H", "Authorization: " + auth,
        "-H", "Content-Type: application/json",
        "-d", payload,
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        resp = json.loads(result.stdout)
        if "error" in resp:
            print(f"{key}: ERROR - {resp['error'].get('message', 'unknown')}")
        else:
            created = resp.get("created", {})
            env_id = created.get("id", "ok")
            print(f"{key}: OK (id={env_id[:12]}...)")
    except:
        print(f"{key}: raw={result.stdout[:300]}")
