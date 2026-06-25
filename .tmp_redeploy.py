import json, subprocess

token = json.load(open('/root/.vercel/auth.json'))['token']
auth = "Bearer " + token

# Get latest deployment for this branch
cmd = [
    "curl", "-s",
    "https://api.vercel.com/v6/deployments?projectId=prj_AanepVpOWTukligeiZ1owmZXbzH1&teamId=cutepelong-8844s-projects&state=READY&target=preview&limit=5",
    "-H", "Authorization: " + auth,
]
result = subprocess.run(cmd, capture_output=True, text=True)
data = json.loads(result.stdout)

deployments = data.get("deployments", [])
print(f"Found {len(deployments)} deployments")

# Find the deployment for our branch and get its uid
target_uid = None
for d in deployments:
    meta = d.get("meta", {})
    branch = meta.get("githubCommitRef", "")
    uid = d.get("uid", "")
    state = d.get("state", "")
    print(f"  uid={uid[:12]}... state={state} branch={branch}")
    if branch == "feat/rsshub-live-discovery-v3" and not target_uid:
        target_uid = uid

if not target_uid:
    print("No deployment found for feat/rsshub-live-discovery-v3")
    exit(1)

print(f"\nRedeploying {target_uid[:12]}...")

# Redeploy using POST /v13/deployments with withLatestSource
payload = json.dumps({
    "name": "paylabs",
    "deploymentId": target_uid,
})

cmd2 = [
    "curl", "-s", "-X", "POST",
    "https://api.vercel.com/v13/deployments?teamId=cutepelong-8844s-projects",
    "-H", "Authorization: " + auth,
    "-H", "Content-Type: application/json",
    "-d", payload,
]

result2 = subprocess.run(cmd2, capture_output=True, text=True)
try:
    resp2 = json.loads(result2.stdout)
    if "error" in resp2:
        print(f"Error: {resp2['error'].get('message', resp2['error'])}")
    else:
        new_uid = resp2.get("uid", "")
        print(f"New deployment uid={new_uid[:12]}... state={resp2.get('state', 'unknown')}")
except:
    print(f"Raw: {result2.stdout[:500]}")
