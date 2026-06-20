import { createHmac, randomUUID } from "crypto";

const HMAC_SECRET = process.env.PAYLABS_HMAC_SECRET;
if (!HMAC_SECRET) throw new Error("No HMAC_SECRET");

const runId = "fcb8b975-14b9-4644-89be-4fdc59d4af4d";
const SIGN_FIELDS = ["run_id","agent_call_id","agent_name","capability","route_tier","settlement_mode","amount_usdc","payer_wallet","payee_wallet","receipt_id","expires_at"];

const agents = [
  { name: "tutor_intake", cap: "normalize_goal", payer: "treasury", payerWallet: "0xb5114ba71523b2f08a56924ded4133b3dd77a57b", payeeWallet: "0x611dccb6061d0462f8c54eab785d4411c8165149" },
  { name: "intent_classifier", cap: "classify_intent", payer: "tutor_intake", payerWallet: "0x611dccb6061d0462f8c54eab785d4411c8165149", payeeWallet: "0xc718c0d97e43566f1e5082bee75ab96469b73611" },
  { name: "query_expander", cap: "expand_query", payer: "intent_classifier", payerWallet: "0xc718c0d97e43566f1e5082bee75ab96469b73611", payeeWallet: "0x84b2c86c99578ea52d79c31869974793ac2261f2" },
  { name: "discovery_ranker", cap: "rank_active_sources", payer: "query_expander", payerWallet: "0x84b2c86c99578ea52d79c31869974793ac2261f2", payeeWallet: "0xcf61f412f593512cd1d82ab81912e18d958e38c1" },
  { name: "source_quality_verifier", cap: "verify_source_quality", payer: "discovery_ranker", payerWallet: "0xcf61f412f593512cd1d82ab81912e18d958e38c1", payeeWallet: "0x573ce5a2a562520dca49cf0da09ef7e842fb3487" },
  { name: "provenance_verifier", cap: "verify_provenance", payer: "source_quality_verifier", payerWallet: "0x573ce5a2a562520dca49cf0da09ef7e842fb3487", payeeWallet: "0x308d8a1df117c7dc5ac1889a214128de70f02461" },
  { name: "attribution_auditor", cap: "audit_attribution", payer: "provenance_verifier", payerWallet: "0x308d8a1df117c7dc5ac1889a214128de70f02461", payeeWallet: "0xb5bc0959f9f1528927575592d4d64a47a1afc393" },
];

// 1. Test simple POST (no auth) to verify route exists
console.log("=== Route check ===");
const r0 = await fetch("https://paylabs.vercel.app/api/paylabs/agent-capabilities/tutor-intake", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
console.log("No auth HTTP:", r0.status, (await r0.text()).slice(0, 80));

// 2. Full chain
console.log("\n=== Full 7-agent chain ===");
let allPassed = true;

for (const agent of agents) {
  const receiptId = randomUUID();
  const expiresAt = new Date(Date.now() + 5*60*1000).toISOString();

  const payload = {
    run_id: runId,
    agent_call_id: randomUUID(),
    payer_agent: agent.payer,
    payee_agent: agent.name,
    agent_name: agent.name,
    capability: agent.cap,
    route_tier: "easy",
    payment_route: "circle_gateway_x402",
    settlement_mode: "nano",
    payment_kind: "agent_capability_fee",
    amount_usdc: "0.000001",
    payer_wallet: agent.payerWallet,
    payee_wallet: agent.payeeWallet,
    receipt_id: receiptId,
    receipt_url: "/api/paylabs/receipts/" + receiptId,
    expires_at: expiresAt,
  };

  const message = SIGN_FIELDS.map(f => f + ":" + payload[f]).join("|");
  const sig = createHmac("sha256", HMAC_SECRET).update(message).digest("hex");
  const contextJson = JSON.stringify({ ...payload, sig });

  const res = await fetch("https://paylabs.vercel.app/api/paylabs/agent-capabilities/" + agent.name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": "test-x402-payload",
      "x-paylabs-agent-context": contextJson,
      "x-paylabs-receipt-link": "/api/paylabs/receipts/" + receiptId,
    },
    body: JSON.stringify({ goal: "Learn about AI agents and nanopayments" }),
  });

  const text = await res.text();
  let r;
  try { r = JSON.parse(text); } catch { r = { error: text.slice(0, 80) }; }
  const ok = res.status === 200;
  if (!ok) allPassed = false;
  console.log(ok ? "✅" : "❌", agent.payer, "→", agent.name, "HTTP", res.status, r.status || r.error?.slice(0, 60));
}

console.log("\n" + (allPassed ? "✅ ALL 7 AGENTS PASSED" : "❌ SOME AGENTS FAILED"));
