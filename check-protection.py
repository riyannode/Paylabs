import json, urllib.request

token = json.load(open('/root/.vercel/auth.json'))['token']

# Get project details to find protection settings
url = "https://api.vercel.com/v9/projects/prj_AanepVpOWTukligeiZ1owmZXbzH1?teamId=team_d1Ss5unGp0JBzkBgyCQ0RRPR"
req = urllib.request.Request(url, headers={
    'Authorization': f'Bearer {token}',
})

resp = urllib.request.urlopen(req)
d = json.loads(resp.read())

# Print protection-related settings
for key in sorted(d.keys()):
    if 'protect' in key.lower() or 'auth' in key.lower() or 'sso' in key.lower() or 'auto' in key.lower() or 'bypass' in key.lower():
        print(f"{key}: {d[key]}")

# Also check if there's a deployment protection bypass
print("\n--- All project keys ---")
print(sorted(d.keys()))
