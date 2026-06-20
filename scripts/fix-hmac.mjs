import { readFileSync } from "fs";

const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;
const envContent = readFileSync("/root/Paylabs/.env.local", "utf8");
const hmacVal = envContent.split("\n").find(l => l.startsWith("PAYLABS_HMAC_SECRET=*** (!hmacVal) { console.error("No HMAC"); process.exit(1); }
const projectId = "prj_AanepVpOWTukligeiZ1owmZXbzH1";

// Get existing HMAC env var
const listRes = await fetch(`https://api.vercel.com/v9/projects/${projectId}/env`, {
  headers: { Authorization: `Bearer ${token}` }
});
const listData = await listRes.json();
const existing = listData.envs.find(e => e.key === "PAYLABS_HMAC_SECRET" && e.target?.includes("production"));

if (existing) {
  // Update
  const patchRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env/${existing.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: hmacVal, target: ["production", "preview"] })
  });
  const patchData = await patchRes.json();
  console.log(patchData.error ? `Error: ${patchData.error.message}` : "Updated HMAC secret for production + preview");
} else {
  console.log("No existing HMAC var found");
}
