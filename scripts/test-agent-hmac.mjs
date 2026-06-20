/**
 * HMAC Test — Verifies x-paylabs-agent-context signing format.
 *
 * The correct format is: JSON.stringify(context)
 * where context = { ...payload, sig: hmac_signature }
 *
 * NOT base64(payload).signature
 *
 * The 3 request headers are:
 *   x-payment              — Gateway/x402 payment payload
 *   x-paylabs-agent-context — Raw JSON string (signed context)
 *   x-paylabs-receipt-link  — Receipt URL
 */

import { createHmac, randomUUID } from "crypto";

const envContent = (await import("fs")).readFileSync("/root/Paylabs/.env.local", "utf8");
const hmacSecret = envContent.split("\n").find(l => l.startsWith("PAYLABS_HMAC_SECRET="))?.split("=").slice(1).join("=");

if (!hmacSecret) {
  console.error("No HMAC secret found in .env.local");
  process.exit(1);
}

const baseUrl = process.argv[2] || "https://paylabs.vercel.app";

const SIGN_FIELDS = [
  "run_id", "agent_call_id", "agent_name", "capability",
  "route_tier", "settlement_mode", "amount_usdc",
  "payer_wallet", "payee_wallet", "receipt_id", "expires_at",
];

/**
 * Create signed agent context matching createAgentContext() format.
 * Returns raw JSON string — NOT base64.
 */
function createSignedContext(agentName, capability, payerWallet, payeeWallet) {
  const runId = "00000000-0000-0000-0000-000000000001";
  const receiptId = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const payload = {
    run_id: runId,
    agent_call_id: randomUUID(),
    payer_agent: "test_payer",
    payee_agent: agentName,
    agent_name: agentName,
    capability: capability,
    route_tier: "easy",
    payment_route: "circle_gateway_x402",
    settlement_mode: "nano",
    payment_kind: "agent_capability_fee",
    amount_usdc: "0.000001",
    payer_wallet: payerWallet,
    payee_wallet: payeeWallet,
    receipt_id: receiptId,
    receipt_url: `/api/paylabs/receipts/${receiptId}`,
    expires_at: expiresAt,
  };

  // Sign: field:value|field:value|...
  const message = SIGN_FIELDS.map(f => `${f}:${payload[f]}`).join("|");
  const sig = createHmac("sha256", hmacSecret).update(message).digest("hex");

  // Return raw JSON string — this is the correct format
  return JSON.stringify({ ...payload, sig });
}

// ─── Test 1: No auth → expect 400 ─────────────────────────────
console.log("=== TEST 1: No auth headers ===");
const r1 = await fetch(`${baseUrl}/api/paylabs/agent-capabilities/tutor-intake`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({})
});
console.log(`Status: ${r1.status}`);
const d1 = await r1.json();
console.log("Response:", JSON.stringify(d1));
console.log(`PASS: ${r1.status === 400 ? "✅" : "❌"}\n`);

// ─── Test 2: Invalid context → expect 403 ─────────────────────
console.log("=== TEST 2: Invalid context ===");
const r2 = await fetch(`${baseUrl}/api/paylabs/agent-capabilities/tutor-intake`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-payment": "none",
    "x-paylabs-agent-context": "not-valid-json",
    "x-paylabs-receipt-link": "https://example.com"
  },
  body: JSON.stringify({ goal: "test" })
});
console.log(`Status: ${r2.status}`);
const d2 = await r2.json();
console.log("Response:", JSON.stringify(d2));
console.log(`PASS: ${r2.status === 403 ? "✅" : "❌"}\n`);

// ─── Test 3: Valid signed context (raw JSON) → expect 200 ─────
console.log("=== TEST 3: Valid signed context (raw JSON format) ===");
const context = createSignedContext(
  "tutor_intake",
  "normalize_goal",
  "0xb5114ba71523b2f08a56924ded4133b3dd77a57b",
  "0x611dccb6061d0462f8c54eab785d4411c8165149"
);

// Verify format is raw JSON, not base64
const parsed = JSON.parse(context);
console.log("Context format: raw JSON ✅");
console.log("Has sig:", !!parsed.sig ? "✅" : "❌");
console.log("Agent:", parsed.agent_name);

const r3 = await fetch(`${baseUrl}/api/paylabs/agent-capabilities/tutor-intake`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-payment": "test-x402-payload",
    "x-paylabs-agent-context": context,
    "x-paylabs-receipt-link": `https://paylabs.vercel.app/api/paylabs/receipts/${parsed.receipt_id}`
  },
  body: JSON.stringify({ goal: "learn about Arc blockchain" })
});
console.log(`Status: ${r3.status}`);
const d3 = await r3.json();
console.log("Response:", JSON.stringify(d3, null, 2).substring(0, 500));
console.log("Response headers:");
console.log(`  x-payment-response: ${r3.headers.get("x-payment-response")}`);
console.log(`  x-paylabs-agent-context: ${r3.headers.get("x-paylabs-agent-context") ? "present" : "missing"}`);
console.log(`  x-paylabs-receipt-link: ${r3.headers.get("x-paylabs-receipt-link") ? "present" : "missing"}`);
console.log(`PASS: ${r3.status === 200 ? "✅" : "❌"}\n`);

// ─── Test 4: All 7 agents with valid format ───────────────────
console.log("=== TEST 4: All 7 agents (raw JSON format) ===");
const agents = [
  { name: "tutor-intake", regName: "tutor_intake", cap: "normalize_goal" },
  { name: "intent-classifier", regName: "intent_classifier", cap: "classify_intent" },
  { name: "query-expander", regName: "query_expander", cap: "expand_query" },
  { name: "discovery-ranker", regName: "discovery_ranker", cap: "rank_active_sources" },
  { name: "source-quality-verifier", regName: "source_quality_verifier", cap: "verify_source_quality" },
  { name: "provenance-verifier", regName: "provenance_verifier", cap: "verify_provenance" },
  { name: "attribution-auditor", regName: "attribution_auditor", cap: "audit_attribution" },
];

let allPassed = true;
for (const agent of agents) {
  const ctx = createSignedContext(
    agent.regName,
    agent.cap,
    "0xb5114ba71523b2f08a56924ded4133b3dd77a57b",
    "0x611dccb6061d0462f8c54eab785d4411c8165149"
  );
  const parsedCtx = JSON.parse(ctx);

  const r = await fetch(`${baseUrl}/api/paylabs/agent-capabilities/${agent.name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": "test-x402-payload",
      "x-paylabs-agent-context": ctx,
      "x-paylabs-receipt-link": `https://paylabs.vercel.app/api/paylabs/receipts/${parsedCtx.receipt_id}`
    },
    body: JSON.stringify({})
  });
  const d = await r.json();
  const ok = r.status === 200;
  if (!ok) allPassed = false;
  const icon = ok ? "✅" : "❌";
  console.log(`  ${icon} ${agent.regName}: HTTP ${r.status} — ${d.db_status || d.error || "ok"}`);
}

console.log(`\n${allPassed ? "✅ ALL 7 AGENTS PASSED" : "❌ SOME AGENTS FAILED"}`);
console.log("\nFormat verification: x-paylabs-agent-context is raw JSON (not base64) ✅");
