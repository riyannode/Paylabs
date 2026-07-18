import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { publicError } from "@/lib/paylabs/public-api/errors";
import { loadAuthorizedPublicRun } from "@/lib/paylabs/public-api/read";
import { normalizePublicResult } from "@/lib/paylabs/public-api/response";

function hash(v: unknown) { return createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex"); }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const token = req.nextUrl.searchParams.get("read_token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  const run = await loadAuthorizedPublicRun(runId, token);
  if (run === false) return publicError("READ_TOKEN_INVALID", "Invalid read token.");
  if (!run) return publicError("RUN_NOT_FOUND", "Run not found.");
  const trace = rec(run.agent_trace);
  const pf = rec(trace.auto_tier_preflight);
  const ex = rec(trace.auto_tier_execution);
  const finalPayment = rec(ex.final_payment);
  const result = normalizePublicResult(run, "full");
  return NextResponse.json({ ok: true, receipt: { run_id: run.id, request_hash: run.request_hash, buyer_wallet: run.user_wallet, seller_wallet: process.env.PAYLABS_ENTRY_PAYMENT_SELLER_WALLET_ADDRESS || process.env.PAYLABS_BRAIN_SELLER_WALLET_ADDRESS || null, requested_tier: pf.requested_route_tier ?? run.route_tier, effective_tier: run.effective_route_tier ?? pf.selected_tier, final_answer_hash: hash(result.answer), source_references: result.sources.map((s) => ({ id: s.id, title: s.title, url: s.url, url_hash: hash(s.url) })), total_cost_usdc: Number(pf.routing_fee_usdc || 0) + Number(run.entry_payment_amount_usdc || pf.final_entry_payment_usdc || 0), entry_payment: { amount_usdc: run.entry_payment_amount_usdc ?? pf.final_entry_payment_usdc, settlement_id: run.entry_payment_settlement_id ?? finalPayment.settlement_id, tx_hash: run.entry_payment_tx_hash ?? finalPayment.tx_hash, explorer_url: run.entry_payment_explorer_url ?? finalPayment.explorer_url }, internal_payment_graph_summary: trace.payment_graph ?? [], creator_payouts: rec(trace.creator_distribution).payoutResults ?? [], settlement_id: run.entry_payment_settlement_id ?? finalPayment.settlement_id, entry_transaction: run.entry_payment_tx_hash ?? finalPayment.tx_hash, batch_transaction: run.entry_payment_batch_tx_hash ?? finalPayment.batch_tx_hash ?? null, timestamps: { created_at: run.created_at, started_at: run.started_at, completed_at: run.completed_at } } });
}
