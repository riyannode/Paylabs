import assert from "node:assert/strict";
import test from "node:test";
import { addUsdc, constantTimeEqualHex, createReadToken, parseUsdc, sha256Hex, usdcToAtomic } from "../../lib/paylabs/public-api/security";
import { publicStatusFromRunStatus } from "../../lib/paylabs/public-api/lifecycle";
import { normalizePublicResult, buildPublicRunResponse } from "../../lib/paylabs/public-api/response";

process.env.PAYLABS_APP_URL = "https://paylabs.example";
process.env.PAYLABS_ENTRY_PAYMENT_SELLER_WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

test("USDC parsing and addition stay decimal-safe", () => {
  assert.equal(parseUsdc("0.1", "0.000001"), "0.100000");
  assert.equal(usdcToAtomic("0.100001").toString(), "100001");
  assert.equal(addUsdc("0.000001", "0.100001"), "0.100002");
  assert.equal(parseUsdc("0.0000001", "0.000001"), null);
});

test("read capability uses a random token hash and constant-time comparison", () => {
  const first = createReadToken();
  const second = createReadToken();
  assert.notEqual(first.token, second.token);
  assert.equal(constantTimeEqualHex(first.hash, sha256Hex(first.token)), true);
  assert.equal(constantTimeEqualHex(first.hash, sha256Hex(second.token)), false);
});

test("source normalization falls back from empty source_snapshot to final trace source context", () => {
  const result = normalizePublicResult({
    final_answer: "answer",
    source_snapshot: {},
    agent_trace: {
      source_context: {
        sources_used: [{ title: "Trace source", url: "https://example.com/source", summary: "shown in chat", published_at: "2026-07-18T00:00:00.000Z" }],
      },
    },
  }, "compact");

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.title, "Trace source");
});

test("public status does not map every non-failed lifecycle state to completed", () => {
  assert.equal(publicStatusFromRunStatus("awaiting_payment"), "awaiting_payment");
  assert.equal(publicStatusFromRunStatus("payment_processing"), "payment_processing");
  assert.equal(publicStatusFromRunStatus("executing"), "executing");
  assert.equal(publicStatusFromRunStatus("paid_path_available"), "completed");
});

test("response uses persisted gateway and pending batch metadata", () => {
  const response = buildPublicRunResponse({
    id: "00000000-0000-4000-8000-000000000001",
    status: "paid",
    user_wallet: "0x2222222222222222222222222222222222222222",
    entry_payment_status: "paid",
    agent_trace: {
      auto_tier_preflight: { routing_fee_usdc: "0.000001", final_entry_payment_usdc: "0.000003" },
      auto_tier_execution: {
        final_payment: { gateway_accepted: false, batch_resolver_url: "/api/paylabs/x402/batch-tx/00000000-0000-4000-8000-000000000001" },
      },
    },
  }, null, "compact") as { status: string; cost: { total_user_cost_usdc: string }; payment: { gateway_accepted: boolean; batch: { status: string } } };

  assert.equal(response.status, "paid");
  assert.equal(response.cost.total_user_cost_usdc, "0.000004");
  assert.equal(response.payment.gateway_accepted, false);
  assert.equal(response.payment.batch.status, "pending");
});
