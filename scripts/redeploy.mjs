import { readFileSync } from "fs";
const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;
const projectId = "prj_AanepVpOWTukligeiZ1owmZXbzH1";

// Get project link info
const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}`, {
  headers: { Authorization: `Bearer ${token}` }
});
const data = await res.json();
const link = data.link;
console.log("Project link:", JSON.stringify(link, null, 2));

// Trigger redeploy
const deployRes = await fetch("https://api.vercel.com/v13/deployments", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "paylabs",
    target: "production",
    gitSource: { type: "github", ref: "main", repoId: link.repoId }
  })
});
const deployData = await deployRes.json();
if (deployData.error) {
  console.log("Deploy error:", deployData.error.message);
} else {
  console.log("Deploy triggered:", deployData.url);
}
