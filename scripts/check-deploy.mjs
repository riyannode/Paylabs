import { readFileSync } from "fs";
const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;

// Check latest deployment
const res = await fetch("https://api.vercel.com/v6/deployments?projectId=prj_AanepVpOWTukligeiZ1owmZXbzH1&limit=2", {
  headers: { Authorization: `Bearer ${token}` }
});
const data = await res.json();
for (const d of data.deployments || []) {
  console.log(`${d.url} → ${d.state} (${d.target}) created=${new Date(d.createdAt).toISOString()}`);
}
