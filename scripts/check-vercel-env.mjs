import { readFileSync } from "fs";
const token = JSON.parse(readFileSync("/root/.vercel/auth.json", "utf8")).token;
const res = await fetch("https://api.vercel.com/v9/projects/prj_AanepVpOWTukligeiZ1owmZXbzH1/env?decrypt=true", {
  headers: { Authorization: `Bearer ${token}` }
});
const data = await res.json();
for (const env of data.envs || []) {
  if (env.key.startsWith("PAYLABS") || env.key.startsWith("CIRCLE")) {
    const val = env.value?.length > 30 ? env.value.slice(0, 15) + "..." + env.value.slice(-5) : env.value;
    const targets = (env.target || []).join(",");
    console.log(`${env.key}=${val} [${targets}]`);
  }
}
