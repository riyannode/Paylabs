import { resolvePublicAppUrl } from "@/lib/paylabs/runtime/resolve-app-url";
import type { PublicResearchResult, PublicResponseMode, PublicSource } from "./types";
import { addUsdc, sha256Hex } from "./security";
import { publicStatusFromRunStatus } from "./lifecycle";

function asRecord(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function asString(v: unknown): string | null { return typeof v === "string" && v.trim() ? v.trim() : null; }

export function normalizePublicResult(run: Record<string, unknown>, mode: PublicResponseMode): PublicResearchResult {
  const trace = asRecord(run.agent_trace);
  const sourceSnapshot = asRecord(run.source_snapshot);
  const snapshotSourceContext = asRecord(sourceSnapshot.source_context);
  const traceSourceContext = asRecord(trace.source_context);
  const sourceContext = Object.keys(snapshotSourceContext).length > 0 ? snapshotSourceContext : traceSourceContext;
  const exitOutput = asRecord(trace.exit_output);
  const brain = asRecord(trace.brain_planning);
  const preflight = asRecord(trace.auto_tier_preflight);
  const rawSources = (Array.isArray(sourceContext.sources_used) ? sourceContext.sources_used : Array.isArray(exitOutput.sources_used) ? exitOutput.sources_used : []) as unknown[];
  const sources: PublicSource[] = rawSources.slice(0, 20).map((item, index) => {
    const s = asRecord(item);
    const url = asString(s.url) || asString(s.source_url) || "";
    return {
      id: asString(s.id) || asString(s.feed_item_id) || sha256Hex(`${url}:${index}`).slice(0, 16),
      title: asString(s.title) || asString(s.source_title) || url || "Untitled source",
      url,
      summary: asString(s.summary) || asString(s.reason) || null,
      published_at: asString(s.published_at) || asString(s.publishedAt) || asString(s.pubDate) || null,
    };
  }).filter((s) => /^https?:\/\//.test(s.url));
  const steps = mode === "full" ? ((trace.safe_progress_summaries as unknown[]) || []).filter((v): v is string => typeof v === "string") : undefined;
  return {
    answer: asString(run.final_answer) || asString(sourceSnapshot.final_answer) || asString(trace.final_answer) || asString(exitOutput.final_answer),
    reasoning: {
      summary: asString(brain.user_visible_reasoning) || asString(brain.safe_brain_summary) || asString(preflight.brain_fields && asRecord(preflight.brain_fields).safe_brain_summary) || null,
      route_reason: asString(brain.tier_decision_reason) || asString(asRecord(preflight.brain_fields).tier_decision_reason) || null,
      plan_summary: asString(brain.plan_rationale) || asString(brain.assistant_response) || null,
      ...(steps ? { steps } : {}),
    },
    sources,
  };
}

function batchStatus(entry: Record<string, unknown>) {
  if (asString(entry.batch_tx_hash) || asString(entry.batchTxHash)) return "resolved";
  if (asString(entry.batch_resolver_url) || asString(entry.batchResolverUrl) || asString(entry.settlement_id)) return "pending";
  return "unavailable";
}

export function buildPublicRunResponse(run: Record<string, unknown>, readToken: string | null, mode: PublicResponseMode = "compact") {
  const { baseUrl } = resolvePublicAppUrl();
  const trace = asRecord(run.agent_trace);
  const pf = asRecord(trace.auto_tier_preflight);
  const ex = asRecord(trace.auto_tier_execution);
  const finalPayment = asRecord(ex.final_payment);
  const entry = {
    amount_usdc: asString(run.entry_payment_amount_usdc) || String(pf.final_entry_payment_usdc ?? "0.000000"),
    settlement_id: asString(run.entry_payment_settlement_id) || asString(finalPayment.settlement_id),
    tx_hash: asString(run.entry_payment_tx_hash) || asString(finalPayment.tx_hash),
    explorer_url: asString(run.entry_payment_explorer_url) || asString(finalPayment.explorer_url),
    batch_tx_hash: asString(run.entry_payment_batch_tx_hash) || asString(finalPayment.batch_tx_hash),
    batch_explorer_url: asString(run.entry_payment_batch_explorer_url) || asString(finalPayment.batch_explorer_url),
    batch_resolver_url: asString(finalPayment.batch_resolver_url),
  };
  const result = normalizePublicResult(run, mode);
  const effectiveTier = asString(run.effective_route_tier) || asString(run.route_tier) || asString(pf.selected_tier) || "auto";
  const requestedTier = asString(pf.requested_route_tier) || asString(run.route_tier) || "auto";
  const publicCtx = asRecord(trace.public_x402);
  const response: Record<string, unknown> = {
    ok: true,
    status: publicStatusFromRunStatus(run.status),
    run_id: run.id,
    result,
    route: { requested_tier: requestedTier, effective_tier: effectiveTier, explanation: result.reasoning.route_reason },
    cost: { currency: "USDC", network: "arc-testnet", entry_payment_usdc: entry.amount_usdc, total_user_cost_usdc: addUsdc(pf.routing_fee_usdc, entry.amount_usdc) },
    payment: {
      status: run.entry_payment_status || "paid",
      payer: asString(run.user_wallet) || asString(publicCtx.buyer_wallet),
      payee: process.env.PAYLABS_ENTRY_PAYMENT_SELLER_WALLET_ADDRESS || process.env.PAYLABS_BRAIN_SELLER_WALLET_ADDRESS || null,
      settlement_id: entry.settlement_id,
      tx_hash: entry.tx_hash,
      explorer_url: entry.explorer_url,
      gateway_accepted: typeof finalPayment.gateway_accepted === "boolean" ? finalPayment.gateway_accepted : run.entry_payment_status === "paid",
      batch: { status: batchStatus(entry), tx_hash: entry.batch_tx_hash, explorer_url: entry.batch_explorer_url, resolver_url: entry.batch_resolver_url },
    },
    links: { paylabs_explorer_url: `${baseUrl}/paylabs/explorer/${run.id}`, entry_payment_explorer_url: entry.explorer_url, gateway_batch_url: entry.batch_explorer_url || entry.batch_resolver_url },
    receipt: { ready: run.receipt_ready ?? true, url: `${baseUrl}/receipts/${run.id}`, api_url: `${baseUrl}/api/x402/v1/runs/${run.id}/receipt`, authorization: readToken ? "Bearer" : null },
    ...(readToken ? { read_token: readToken } : {}),
  };
  if (mode === "full") {
    response.safe_execution = {
      locked_execution_plan: { selected_macro_nodes: pf.locked_selected_macro_nodes ?? [], selected_services: pf.locked_selected_services ?? [], planned_cost_usdc: pf.locked_planned_cost_usdc ?? null, planned_cost_breakdown: pf.locked_planned_cost_breakdown ?? null, locked: true },
      phases_completed: trace.phases_completed ?? [],
      payment_plan: trace.payment_plan ?? null,
      payment_graph_summary: (Array.isArray(trace.payment_graph) ? trace.payment_graph : []).map((e) => { const r = asRecord(e); return { edge_id: r.edge_id, buyer: r.buyer, seller: r.seller, amount_usdc: r.amount_usdc, status: r.status, node_type: r.node_type, tx_hash: r.tx_hash, explorer_url: r.explorer_url, settlement_id: r.settlement_id, batch_tx_hash: r.batch_tx_hash, batch_explorer_url: r.batch_explorer_url, batch_resolver_url: r.batch_resolver_url }; }),
      creator_payout_summary: asRecord(trace.creator_distribution).payoutSummary ?? null,
      source_context: { source_count: asRecord(trace.source_context).source_count ?? result.sources.length, source_confidence: asRecord(trace.source_context).source_confidence ?? null, retrieval_mode: asRecord(trace.source_context).retrieval_mode ?? null },
      budget_snapshot: trace.budget_snapshot ?? null,
    };
  }
  return response;
}
