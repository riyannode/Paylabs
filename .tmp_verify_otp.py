#!/usr/bin/env python3
"""Retrieve OTP from Supabase + verify + get session cookie."""
import hashlib, json, subprocess, sys

srk = None
with open("/root/Paylabs/.env.vercel.preview") as f:
    for line in f:
        if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
            srk = line.split("=", 1)[1].strip().strip('"')
            break

REF = "qosxyriijjqcfvzlqsal"
EMAIL = "ardianjaka319@gmail.com"
BASE = "https://paylabs-git-feat-rsshub-live-d-6d06c3-cutepelong-8844s-projects.vercel.app"

# Query latest OTP hash
auth = "Bearer " + srk
cmd = [
    "curl", "-s",
    f"https://{REF}.supabase.co/rest/v1/paylabs_email_otps?email=eq.{EMAIL}&order=created_at.desc&limit=1",
    "-H", f"apikey: {srk}",
    "-H", "Authorization: " + auth,
    "-H", "Content-Type: application/json",
]
result = subprocess.run(cmd, capture_output=True, text=True)
data = json.loads(result.stdout)
if not data:
    print("No OTP rows found"); sys.exit(1)

otp_hash = data[0].get("code_hash")
created = data[0].get("created_at")
print(f"Latest OTP: created={created}")

# Brute force
print("Brute-forcing...")
code_found = None
for i in range(1000000):
    code = str(i).zfill(6)
    if hashlib.sha256(code.encode()).hexdigest() == otp_hash:
        code_found = code
        print(f"OTP CODE: {code}")
        break

if not code_found:
    print("ERROR: Could not find matching OTP"); sys.exit(1)

# Verify OTP and get session cookie
verify_cmd = [
    "curl", "-s", "-c", "/tmp/dcw_cookies.txt",
    f"{BASE}/api/paylabs/auth/otp/verify",
    "-X", "POST",
    "-H", "Content-Type: application/json",
    "-d", json.dumps({"email": EMAIL, "code": code_found}),
]
verify_result = subprocess.run(verify_cmd, capture_output=True, text=True)
print(f"Verify response: {verify_result.stdout[:300]}")

# Read cookies
try:
    with open("/tmp/dcw_cookies.txt") as f:
        cookie_content = f.read()
    print(f"Cookies:\n{cookie_content}")
except:
    print("No cookie file")
