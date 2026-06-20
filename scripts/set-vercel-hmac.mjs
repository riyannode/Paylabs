import { readFileSync } from "fs";

const envContent = readFileSync("/root/Paylabs/.env.local", "utf8");
const hmacLine = envContent.split("\n").find(l => l.startsWith("PAYLABS_HMAC_SECRET="));
if (!hmacLine) { console.error("No HMAC secret"); process.exit(1); }
const hmacVal = hmacLine.split("=")[1].trim();

const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;
const projectId = "prj_AanepVpOWTukligeiZ1owmZXbzH1";

for (const env of ["production", "preview"]) {
  const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key: "PAYLABS_HMAC_SECRET",
      value: hmacVal,
      type: "encrypted",
      target: [env],
    }),
  });
  const d = await res.json();
  if (d.error) {
    console.log(`${env}: ${d.error.message}`);
  } else {
    console.log(`${env}: ok (key=${d.key})`);
  }
}
