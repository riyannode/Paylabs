import { supabaseAdmin } from "@/lib/supabase/server";

type DisplayStatus = "paid" | "settled" | "pending" | "failed";
type BatchStatus = "settled" | "queued" | "pending";

const RECEIPT_SAFE_FIELDS = [
  "discovery_run_id",
  "created_at",
  "selected_tier",
  "planned_cost_usdc",
  "actual_settled_usdc",
  "remaining_budget_usdc",
  "payment_count",
  "safe_receipt_summary",
  "execution_fee_usdc",
  "planned_creator_pool_usdc",
  "actual_creator_paid_usdc",
  "planned_creator_payout_count",
  "actual_creator_payout_count",
  "pending_creator_reserve_usdc",
  "bot_share_usdc",
  "service_share_usdc",
  "creator_split_policy",
  "creator_payout_status",
  "advanced_evaluator_used",
  "advanced_evaluator_confidence",
  "advanced_evaluator_rationale",
  "why_two_sources_needed",
  "last_batch_tx_hash",
  "last_batch_explorer_url",
].join(",");

const RECEIPT_LIST_FIELDS = [
  "discovery_run_id",
  "created_at",
  "selected_tier",
  "actual_settled_usdc",
  "planned_cost_usdc",
  "payment_count",
  "actual_creator_payout_count",
  "planned_creator_payout_count",
  "last_batch_tx_hash",
  "last_batch_explorer_url",
  "safe_receipt_summary",
].join(",");

const CREATOR_SAFE_FIELDS = [
  "id",
  "route_tier",
  "source_url",
  "source_title",
  "creator_wallet",
  "status",
  "planned_amount_usdc",
  "actual_amount_usdc",
  "split_policy",
  "safe_summary",
  "created_at",
].join(",");

const SOURCE_SAFE_FIELDS = [
  "id",
  "source_url",
  "source_title",
  "publisher",
  "creator_wallet",
  "claim_status",
  "eligibility_status",
  "final_score",
  "risk_score",
  "attribution_reason",
  "created_at",
].join(",");

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shortWallet(value: unknown): string | null {
  const wallet = toStringOrNull(value);
  if (!wallet) return null;
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function safeHttpUrl(value: unknown): string | null {
  const raw = toStringOrNull(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function receiptId(runId: string): string {
  return `#RCPT-${runId.slice(0, 6)}`;
}

function displayStatus(row: any): DisplayStatus {
  const summary = String(row.safe_receipt_summary || "").toLowerCase();
  const paymentCount = Number(row.payment_count || 0);
  const settled = Number(row.actual_settled_usdc || 0);
  if (summary.includes("failed") || summary.includes("error")) return "failed";
  if (row.last_batch_explorer_url || row.last_batch_tx_hash) return "settled";
  if (settled > 0 || paymentCount > 0) return "paid";
  return "pending";
}

function batchStatus(row: any): BatchStatus {
  const paymentCount = Number(row.payment_count || 0);
  const settled = Number(row.actual_settled_usdc || 0);
  if (row.last_batch_explorer_url || row.last_batch_tx_hash) return "settled";
  if (settled > 0 || paymentCount > 0) return "queued";
  return "pending";
}

function mapReceiptDetail(row: any, creators: any[], sources: any[]) {
  return {
    id: row.discovery_run_id,
    discoveryRunId: row.discovery_run_id,
    createdAt: row.created_at,
    receiptId: receiptId(row.discovery_run_id),
    selectedTier: row.selected_tier ?? null,
    plannedCostUsdc: toNumber(row.planned_cost_usdc),
    actualSettledUsdc: toNumber(row.actual_settled_usdc),
    remainingBudgetUsdc: toNumber(row.remaining_budget_usdc),
    paymentCount: toNumber(row.payment_count),
    safeReceiptSummary: row.safe_receipt_summary ?? null,
    executionFeeUsdc: toNumber(row.execution_fee_usdc),
    plannedCreatorPoolUsdc: toNumber(row.planned_creator_pool_usdc),
    actualCreatorPaidUsdc: toNumber(row.actual_creator_paid_usdc),
    plannedCreatorPayoutCount: toNumber(row.planned_creator_payout_count),
    actualCreatorPayoutCount: toNumber(row.actual_creator_payout_count),
    pendingCreatorReserveUsdc: toNumber(row.pending_creator_reserve_usdc),
    botShareUsdc: toNumber(row.bot_share_usdc),
    serviceShareUsdc: toNumber(row.service_share_usdc),
    creatorSplitPolicy: row.creator_split_policy ?? null,
    creatorPayoutStatus: row.creator_payout_status ?? null,
    advancedEvaluatorUsed: row.advanced_evaluator_used ?? null,
    advancedEvaluatorConfidence: toNumber(row.advanced_evaluator_confidence),
    advancedEvaluatorRationale: row.advanced_evaluator_rationale ?? null,
    whyTwoSourcesNeeded: row.why_two_sources_needed ?? null,
    lastBatchTxHash: row.last_batch_tx_hash ?? null,
    lastBatchExplorerUrl: row.last_batch_explorer_url ?? null,
    displayStatus: displayStatus(row),
    batchStatus: batchStatus(row),
    creators: creators.map((creator) => ({
      id: String(creator.id),
      routeTier: creator.route_tier ?? null,
      sourceUrl: safeHttpUrl(creator.source_url),
      sourceTitle: creator.source_title ?? null,
      creatorWallet: shortWallet(creator.creator_wallet),
      status: creator.status ?? null,
      plannedAmountUsdc: toNumber(creator.planned_amount_usdc),
      actualAmountUsdc: toNumber(creator.actual_amount_usdc),
      splitPolicy: creator.split_policy ?? null,
      safeSummary: creator.safe_summary ?? null,
      createdAt: creator.created_at ?? null,
    })),
    sources: sources.map((source) => ({
      id: String(source.id),
      sourceUrl: safeHttpUrl(source.source_url),
      sourceTitle: source.source_title ?? null,
      publisher: source.publisher ?? null,
      creatorWallet: shortWallet(source.creator_wallet),
      claimStatus: source.claim_status ?? null,
      eligibilityStatus: source.eligibility_status ?? null,
      finalScore: toNumber(source.final_score),
      riskScore: toNumber(source.risk_score),
      attributionReason: source.attribution_reason ?? null,
      createdAt: source.created_at ?? null,
    })),
  };
}

export async function getRunEvents(discoveryRunId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_run_events")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .order("sequence", { ascending: true });

  if (error) throw new Error(`get_run_events_failed: ${error.message}`);
  return data || [];
}

export async function getRunReceipt(discoveryRunId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("*")
    .eq("discovery_run_id", discoveryRunId)
    .single();

  if (error) throw new Error(`get_run_receipt_failed: ${error.message}`);
  return data;
}

export async function getRunReceiptDetail(discoveryRunId: string) {
  const { data: receipt, error: receiptError } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select(RECEIPT_SAFE_FIELDS)
    .eq("discovery_run_id", discoveryRunId)
    .maybeSingle();

  if (receiptError) throw new Error(`get_run_receipt_detail_failed: ${receiptError.message}`);
  if (!receipt) return null;

  const [creatorsResult, sourcesResult] = await Promise.all([
    supabaseAdmin()
      .from("paylabs_creator_payout_events")
      .select(CREATOR_SAFE_FIELDS)
      .eq("discovery_run_id", discoveryRunId)
      .order("created_at", { ascending: true }),
    supabaseAdmin()
      .from("paylabs_source_attributions")
      .select(SOURCE_SAFE_FIELDS)
      .eq("discovery_run_id", discoveryRunId)
      .order("final_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: true }),
  ]);

  if (creatorsResult.error) throw new Error(`get_creator_receipt_rows_failed: ${creatorsResult.error.message}`);
  if (sourcesResult.error) throw new Error(`get_source_receipt_rows_failed: ${sourcesResult.error.message}`);

  return mapReceiptDetail(receipt, creatorsResult.data || [], sourcesResult.data || []);
}

export async function getRecentReceiptList(limit = 25) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select(RECEIPT_LIST_FIELDS)
    .order("created_at", { ascending: false })
    .limit(safeLimit);

  if (error) throw new Error(`recent_receipts_failed: ${error.message}`);

  return (data || []).map((row: any) => ({
    discoveryRunId: row.discovery_run_id,
    receiptId: receiptId(row.discovery_run_id),
    createdAt: row.created_at,
    selectedTier: row.selected_tier ?? null,
    amountUsdc: toNumber(row.actual_settled_usdc) ?? toNumber(row.planned_cost_usdc),
    paymentCount: toNumber(row.payment_count),
    sourceCount: null,
    displayStatus: displayStatus(row),
    batchStatus: batchStatus(row),
  }));
}

export async function getDashboardSummary() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("actual_settled_usdc, service_fees_usdc, source_fees_usdc, creator_reserve_usdc, payment_count");

  if (error) throw new Error(`dashboard_summary_failed: ${error.message}`);

  const rows = data || [];

  return {
    total_runs: rows.length,
    total_settled_usdc: rows.reduce((sum, r) => sum + Number(r.actual_settled_usdc || 0), 0),
    service_fees_usdc: rows.reduce((sum, r) => sum + Number(r.service_fees_usdc || 0), 0),
    source_fees_usdc: rows.reduce((sum, r) => sum + Number(r.source_fees_usdc || 0), 0),
    creator_reserve_usdc: rows.reduce((sum, r) => sum + Number(r.creator_reserve_usdc || 0), 0),
    payment_count: rows.reduce((sum, r) => sum + Number(r.payment_count || 0), 0),
  };
}

export async function getRecentPayments(limit = 25) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recent_payments_failed: ${error.message}`);
  return data || [];
}

export async function getRecentRuns(limit = 25) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recent_runs_failed: ${error.message}`);
  return data || [];
}

export async function getLastTx() {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("tx_hash, explorer_url, discovery_run_id, buyer, seller, amount_usdc, created_at")
    .not("tx_hash", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`last_tx_failed: ${error.message}`);
  return data?.[0] ?? null;
}
