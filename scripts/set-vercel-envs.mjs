import { readFileSync } from "fs";

const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;
const envContent = readFileSync("/root/Paylabs/.env.local", "utf8");
const projectId = "prj_AanepVpOWTukligeiZ1owmZXbzH1";

// Parse .env.local
const envVars = {};
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx);
  const val = trimmed.slice(eqIdx + 1);
  envVars[key] = val;
}

// Vars to set in Vercel (production + preview)
const varsToSet = [
  "CIRCLE_API_KEY",
  "CIRCLE_ENTITY_SECRET",
  "PAYLABS_PAYMENT_ROUTE",
  "PAYLABS_PAYMENT_EXECUTOR",
  "PAYLABS_HMAC_SECRET",
  "PAYLABS_TREASURY_WALLET_ID",
  "PAYLABS_TREASURY_WALLET_ADDRESS",
  "PAYLABS_RESERVE_WALLET_ID",
  "PAYLABS_RESERVE_WALLET_ADDRESS",
  "PAYLABS_AGENT_WALLET_ID_TUTOR_INTAKE",
  "PAYLABS_AGENT_WALLET_TUTOR_INTAKE",
  "PAYLABS_AGENT_WALLET_ID_INTENT_CLASSIFIER",
  "PAYLABS_AGENT_WALLET_INTENT_CLASSIFIER",
  "PAYLABS_AGENT_WALLET_ID_QUERY_EXPANDER",
  "PAYLABS_AGENT_WALLET_QUERY_EXPANDER",
  "PAYLABS_AGENT_WALLET_ID_DISCOVERY_RANKER",
  "PAYLABS_AGENT_WALLET_DISCOVERY_RANKER",
  "PAYLABS_AGENT_WALLET_ID_SOURCE_QUALITY_VERIFIER",
  "PAYLABS_AGENT_WALLET_SOURCE_QUALITY_VERIFIER",
  "PAYLABS_AGENT_WALLET_ID_PROVENANCE_VERIFIER",
  "PAYLABS_AGENT_WALLET_PROVENANCE_VERIFIER",
  "PAYLABS_AGENT_WALLET_ID_ATTRIBUTION_AUDITOR",
  "PAYLABS_AGENT_WALLET_ATTRIBUTION_AUDITOR",
  "PAYLABS_X402_DISCOVERY_FEE_ENABLED",
  "PAYLABS_AGENT_NANOPAYMENTS_ENABLED",
];

// First, delete existing empty env vars
console.log("Fetching existing env vars...");
const listRes = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env`, {
  headers: { Authorization: `Bearer ${token}` }
});
const listData = await listRes.json();
const existing = listData.envs || [];

let setCount = 0;
for (const key of varsToSet) {
  const val = envVars[key];
  if (!val) {
    console.log(`  SKIP ${key} — not in .env.local`);
    continue;
  }

  // Find existing env var
  const existingVar = existing.find(e => e.key === key);
  
  if (existingVar) {
    // Update existing
    for (const target of ["production", "preview"]) {
      const patchRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env/${existingVar.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ value: val, target: [target] })
      });
      const patchData = await patchRes.json();
      if (patchData.error) {
        console.log(`  ❌ ${key} [${target}]: ${patchData.error.message}`);
      } else {
        console.log(`  ✅ ${key} [${target}]: updated`);
        setCount++;
      }
    }
  } else {
    // Create new
    for (const target of ["production", "preview"]) {
      const createRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: val, type: "encrypted", target: [target] })
      });
      const createData = await createRes.json();
      if (createData.error) {
        console.log(`  ❌ ${key} [${target}]: ${createData.error.message}`);
      } else {
        console.log(`  ✅ ${key} [${target}]: created`);
        setCount++;
      }
    }
  }
}

console.log(`\nDone: ${setCount} env vars set`);
