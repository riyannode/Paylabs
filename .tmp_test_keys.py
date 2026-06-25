#!/usr/bin/env python3
"""Test MiMo API keys directly."""
import json, subprocess

base_url = "https://token-plan-sgp.xiaomimimo.com/v1"
model = "mimo-v2.5-pro"

keys = [
    "tp-s7w70rvu95654v230iz8gzzmoqgcun292fjm79n8w8hlsmml",
    "tp-syzzm862qict6lrwxkketwrlwx9jqlof7kpmi55zmcqdbhlo",
    "tp-scma1o6cvjsg7zor17bcfznc9i45cgfs5ecodjgvyacsdrv8",
    "tp-s6bp07v3jzb2vgvk8wuxc0k1hvlbqafk7kd4qixdvteqmsyb",
    "tp-s61jvt7sb4sr3q4rw6h1qae7ikmpztziv2auv0vei24uywfp",
    "tp-svj2dp9xx32ttdg0ewu0rpbtgftz0z4uva93uw8ageraoqyk",
    "tp-sdqx6btnnd1gk8iabqozae5nx4n4cppkpxllvol0w4f9layc",
    "tp-s4rcvsvkxun7vij6y3c4od9n2z95q24smt812s3wao1ctgb2",
    "tp-stlisfuovc85wt6efzk1xgxf0rwy7f06q4n116xi1w7bptua",
    "tp-sg3pgyqvf4ttyve4xrdlp8cm7x7fnyl4bkuqtkfu6neahcls",
    "tp-sclpgvaq42xr17bacy4ne0lf87fau85aop6klxckcfm0t1d6",
    "tp-savmt2a5qb8pon45yk001guv0j9i0yeffwp7kdxgv4osrx9i",
]

payload = json.dumps({
    "model": model,
    "messages": [{"role": "user", "content": "Say hello in one word."}],
    "max_tokens": 10,
})

for i, key in enumerate(keys):
    auth = "Bearer " + key
    cmd = [
        "curl", "-s", "--max-time", "30", "-X", "POST",
        f"{base_url}/chat/completions",
        "-H", "Content-Type: application/json",
        "-H", "Authorization: " + auth,
        "-d", payload,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    resp = result.stdout.strip()
    
    try:
        data = json.loads(resp)
        if "error" in data:
            err = data["error"]
            code = err.get("code", "?")
            msg = err.get("message", str(err))[:80]
            print(f"Key {i+1:2d}: FAIL code={code} msg={msg}")
        elif "choices" in data:
            content = data["choices"][0]["message"]["content"][:40]
            print(f"Key {i+1:2d}: OK   response=\"{content}\"")
            print(f"         WINNER KEY INDEX: {i}")
            break
        else:
            print(f"Key {i+1:2d}: ???  keys={list(data.keys())[:5]}")
    except:
        print(f"Key {i+1:2d}: ERR  raw={resp[:100]}")
