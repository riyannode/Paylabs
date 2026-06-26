import { readFileSync } from "fs";
import { createHash } from "crypto";

const env = {};
for (const line of readFileSync("/root/Paylabs/.env.check", "utf8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)/);
  if (m) { let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); env[m[1].trim()]=v; }
}

const BASE = "https://paylabs-17ypxrtn1-cutepelong-8844s-projects.vercel.app";

// OTP bypass
const codeHash = createHash("sha256").update("123456").digest("hex");
await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/paylabs_email_otps`, {
  method:"POST", headers:{"apikey":env.SUPABASE_SERVICE_ROLE_KEY,"Authorization":`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,"Content-Type":"application/json","Prefer":"return=minimal"},
  body:JSON.stringify({email:"ardianjaka319@gmail.com",code_hash:codeHash,expires_at:new Date(Date.now()+600000).toISOString(),attempts:0})
});
const ver = await fetch(`${BASE}/api/paylabs/auth/otp/verify`, {
  method:"POST", headers:{"Content-Type":"application/json"},
  body:JSON.stringify({email:"ardianjaka319@gmail.com",code:"123456"})
});
const cookie = ver.headers.get("set-cookie")?.match(/paylabs_dcw_session=([^;]+)/)?.[1];
if(!cookie){console.log("No session");process.exit(1);}

// Run paid test
const start = Date.now();
const r = await fetch(`${BASE}/api/paylabs/dcw/run-paid`, {
  method:"POST",
  headers:{"Content-Type":"application/json","Cookie":`paylabs_dcw_session=${cookie}`},
  body:JSON.stringify({goal:"latest GitHub activity for riyannode/Paylabs repository",routeTier:"auto"})
});
const data = await r.json();
const d = data.data || data;
const elapsed = Date.now() - start;

console.log("=== Brain Planner + Full Pipeline Test ===");
console.log("HTTP:", r.status, "| ok:", d.ok, "| status:", d.status);
console.log("error:", d.error?.slice(0, 200));
console.log("mode:", d.mode);
console.log("effective_route_tier:", d.effective_route_tier);
console.log("selected_services:", JSON.stringify(d.selected_services));
console.log("retrieval_mode:", d.source_context?.retrieval_mode || d.retrieval_mode);
console.log("sources_used:", d.source_context?.sources_used?.length ?? "null");
console.log("final_answer:", (d.final_answer || "").slice(0, 300));
console.log("payment_graph:", d.payment_graph?.length, "edges");
console.log("entry_payment:", d.entry_payment?.status, "gw:", d.entry_payment?.gateway_accepted);
console.log("elapsed:", elapsed + "ms");

// Brain planning details
if (d.brain_planning) {
  console.log("\n=== Brain Planning Output ===");
  console.log("route_tier_hint:", d.brain_planning.route_tier_hint);
  console.log("discovery_strategy:", d.brain_planning.discovery_strategy?.slice(0, 150));
  console.log("selected_services:", JSON.stringify(d.brain_planning.selected_services));
  console.log("selected_macro_nodes:", JSON.stringify(d.brain_planning.selected_macro_nodes));
  console.log("tier_decision_reason:", d.brain_planning.tier_decision_reason?.slice(0, 150));
  console.log("safe_brain_summary:", d.brain_planning.safe_brain_summary?.slice(0, 150));
}
if (d.tiered_summaries?.final_summary) console.log("\nfinal_summary:", d.tiered_summaries.final_summary.slice(0, 300));
