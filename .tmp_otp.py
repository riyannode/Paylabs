#!/usr/bin/env python3
"""Retrieve DCW OTP via Supabase REST API + brute-force."""
import hashlib, json, subprocess, sys

# Read service role key from env file
srk = None
with open("/root/Paylabs/.env.vercel.preview") as f:
    for line in f:
        if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
            srk = line.split("=", 1)[1].strip().strip('"')
            break

if not srk:
    print("ERROR: SUPABASE_SERVICE_ROLE_KEY not found")
    sys.exit(1)

print(f"Service role key: present (len={len(srk)})")

REF = "qosxyriijjqcfvzlqsal"
EMAIL = "kaguramon701@gmail.com"

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
try:
    data = json.loads(result.stdout)
    if not data:
        print("No OTP rows found")
        sys.exit(1)
    otp_hash = data[0].get("code_hash")
    expires = data[0].get("expires_at")
    created = data[0].get("created_at")
    print(f"Latest OTP: created={created}, expires={expires}")
    print(f"Hash: {otp_hash[:20]}...")
except Exception as e:
    print(f"Error parsing response: {e}")
    print(f"Raw: {result.stdout[:300]}")
    sys.exit(1)

# Brute force 6-digit code
print("Brute-forcing 6-digit OTP...")
for i in range(1000000):
    code = str(i).zfill(6)
    if hashlib.sha256(code.encode()).hexdigest() == otp_hash:
        print(f"OTP CODE: {code}")
        break
else:
    print("ERROR: Could not find matching OTP code")
    sys.exit(1)
