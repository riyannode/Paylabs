import { NextRequest, NextResponse } from "next/server";
import { publicError } from "@/lib/paylabs/public-api/errors";
import { loadAuthorizedPublicRun } from "@/lib/paylabs/public-api/read";

function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const token = req.nextUrl.searchParams.get("read_token") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || null;
  const run = await loadAuthorizedPublicRun(runId, token);
  if (run === false) return publicError("READ_TOKEN_INVALID", "Invalid read token.");
  if (!run) return publicError("RUN_NOT_FOUND", "Run not found.");
  const trace = rec(run.agent_trace); const pf = rec(trace.auto_tier_preflight); const ex = rec(trace.auto_tier_execution); const fp = rec(ex.final_payment);
  const batchTx = run.entry_payment_batch_tx_hash ?? fp.batch_tx_hash ?? null;
  const resolver = fp.batch_resolver_url ?? null;
  return NextResponse.json({ ok: true, run_id: run.id, payments: { entry_payment: { amount_usdc: run.entry_payment_amount_usdc ?? pf.final_entry_payment_usdc, settlement_id: run.entry_payment_settlement_id ?? fp.settlement_id, tx_hash: run.entry_payment_tx_hash ?? fp.tx_hash, explorer_url: run.entry_payment_explorer_url ?? fp.explorer_url }, preflight_routing_payment: pf.routing_payment ?? null, payment_edge_summary: trace.payment_graph ?? [], creator_payout_summary: rec(trace.creator_distribution).payoutSummary ?? null, batch_proof: { status: batchTx ? "resolved" : resolver ? "pending" : "unavailable", tx_hash: batchTx, explorer_url: run.entry_payment_batch_explorer_url ?? fp.batch_explorer_url ?? null, resolver_url: resolver } } });
}
