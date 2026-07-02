import { supabaseAdmin } from "@/lib/paylabs/db/server";

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

// ─── PR #74: Safe proof field whitelists ────────────────────

const RUN_LIST_SAFE_FIELDS = [
  "discovery_run_id",
  "created_at",
  "selected_tier",
  "actual_settled_usdc",
  "planned_cost_usdc",
  "payment_count",
  "actual_creator_payout_count",
  "planned_creator_payout_count",
  "last_tx_hash",
  "last_explorer_url",
  "last_settlement_id",
  "last_settlement_url",
  "last_batch_tx_hash",
  "last_batch_explorer_url",
  "safe_receipt_summary",
  "creator_payout_status",
  "advanced_evaluator_used",
  "advanced_evaluator_confidence",
  "execution_fee_usdc",
].join(",");

const EVENT_SAFE_FIELDS = [
  "discovery_run_id",
  "route_tier",
  "event_type",
  "actor_type",
  "actor_name",
  "target_type",
  "target_name",
  "status",
  "mode",
  "amount_usdc",
  "tx_hash",
  "explorer_url",
  "settlement_id",
  "settlement_url",
  "batch_tx_hash",
  "batch_explorer_url",
  "safe_summary",
  "error",
  "sequence",
  "created_at",
].join(",");

const PAYMENT_SAFE_FIELDS = [
  "discovery_run_id",
  "node_type",
  "seller",
  "status",
  "mode",
  "amount_usdc",
  "tx_hash",
  "explorer_url",
  "settlement_id",
  "settlement_url",
  "batch_tx_hash",
  "batch_explorer_url",
  "safe_summary",
  "error",
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

function shortId(value: unknown): string | null {
  const s = toStringOrNull(value);
  if (!s) return null;
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function shortHash(value: unknown): string | null {
  const s = toStringOrNull(value);
  if (!s) return null;
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

// ─── Route reasoning helpers ──────────────────────────────

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const GENERIC_REASONING_RE =
  /^(i will find|i will search|i am processing|let me find|i'll look|i'll search|saya akan mencari|saya sedang memproses|mohon tunggu sebentar|gathering information|i'm searching for|i'm looking for|saya sedang mencari)/i;

function isGenericReasoningText(text: string): boolean {
  return GENERIC_REASONING_RE.test(text) && text.length < 200;
}

/**
 * Extract safe, user-visible route reasoning from agent_trace.
 * Reads brain_planning fields only — never exposes raw trace or chain-of-thought.
 * Supports both agent_trace.brain_planning and top-level brain_planning.
 */
function extractSafeRouteReasoning(
  agentTrace: Record<string, unknown>,
): { routeReasoning: string | null; brainRouteTierHint: string | null } {
  const nestedTrace = agentTrace.agent_trace as Record<string, unknown> | undefined;
  const bp =
    (agentTrace?.brain_planning as Record<string, unknown>) ??
    (nestedTrace?.brain_planning as Record<string, unknown>);
  if (!bp) return { routeReasoning: null, brainRouteTierHint: null };

  const candidates = [
    textOrNull(bp.user_visible_reasoning),
    textOrNull(bp.tier_decision_reason),
    textOrNull(bp.plan_rationale),
  ];

  const routeReasoning =
    candidates.find((c) => c !== null && !isGenericReasoningText(c)) ?? null;
  const brainRouteTierHint = textOrNull(bp.route_tier_hint);

  return { routeReasoning, brainRouteTierHint };
}

function safeGatewayStatus(row: Record<string, unknown>): string | null {
  const mode = String(row.mode || "");
  const summary = String(row.safe_summary || "").toLowerCase();
  if (mode === "x402" && (summary.includes("paid") || row.status === "paid")) return "accepted";
  if (mode === "x402_failed" || row.status === "failed") return "failed";
  if (mode === "audit_only") return "pending";
  return null;
}

/** PR #74: Map raw run_events row to safe proof object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSafeEventProof(row: any) {
  return {
    runId: shortId(row.discovery_run_id),
    receiptId: row.discovery_run_id ? receiptId(String(row.discovery_run_id)) : null,
    routeTier: row.route_tier ?? null,
    seq: toNumber(row.sequence),
    phase: row.actor_type ?? null,
    nodeType: row.actor_type ?? null,
    nodeLabel: row.actor_name ?? null,
    targetLabel: row.target_name ?? null,
    eventType: row.event_type ?? null,
    status: row.status ?? null,
    mode: row.mode ?? null,
    amountUsdc: toNumber(row.amount_usdc),
    safeMessage: row.safe_summary ?? null,
    error: toStringOrNull(row.error),
    gatewayStatus: safeGatewayStatus(row),
    settlementId: shortId(row.settlement_id),
    settlementUrl: safeHttpUrl(row.settlement_url),
    batchTxHash: shortHash(row.batch_tx_hash),
    batchExplorerUrl: safeHttpUrl(row.batch_explorer_url),
    txHash: shortHash(row.tx_hash),
    explorerUrl: safeHttpUrl(row.explorer_url),
    createdAt: row.created_at ?? null,
  };
}

/** PR #74: Map raw service_payment_events row to safe proof object */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSafePaymentProof(row: any) {
  return {
    runId: shortId(row.discovery_run_id),
    receiptId: row.discovery_run_id ? receiptId(String(row.discovery_run_id)) : null,
    nodeType: row.node_type ?? null,
    sellerLabel: row.seller ?? null,
    status: row.status ?? null,
    mode: row.mode ?? null,
    amountUsdc: toNumber(row.amount_usdc),
    safeMessage: row.safe_summary ?? null,
    error: toStringOrNull(row.error),
    gatewayStatus: safeGatewayStatus(row),
    settlementId: shortId(row.settlement_id),
    settlementUrl: safeHttpUrl(row.settlement_url),
    batchTxHash: shortHash(row.batch_tx_hash),
    batchExplorerUrl: safeHttpUrl(row.batch_explorer_url),
    txHash: shortHash(row.tx_hash),
    explorerUrl: safeHttpUrl(row.explorer_url),
    createdAt: row.created_at ?? null,
  };
}

/** PR #74: Map raw receipts row to safe run proof object (no user_wallet) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSafeRunProof(row: any) {
  return {
    runId: shortId(row.discovery_run_id),
    receiptId: row.discovery_run_id ? receiptId(String(row.discovery_run_id)) : null,
    createdAt: row.created_at ?? null,
    selectedTier: row.selected_tier ?? null,
    plannedCostUsdc: toNumber(row.planned_cost_usdc),
    actualSettledUsdc: toNumber(row.actual_settled_usdc),
    paymentCount: toNumber(row.payment_count),
    actualCreatorPayoutCount: toNumber(row.actual_creator_payout_count),
    plannedCreatorPayoutCount: toNumber(row.planned_creator_payout_count),
    creatorPayoutStatus: toStringOrNull(row.creator_payout_status),
    advancedEvaluatorUsed: row.advanced_evaluator_used ?? null,
    advancedEvaluatorConfidence: toNumber(row.advanced_evaluator_confidence),
    executionFeeUsdc: toNumber(row.execution_fee_usdc),
    safeReceiptSummary: row.safe_receipt_summary ?? null,
    displayStatus: displayStatus(row),
    batchStatus: batchStatus(row),
    lastBatchTxHash: shortHash(row.last_batch_tx_hash),
    lastBatchExplorerUrl: safeHttpUrl(row.last_batch_explorer_url),
  };
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

function mapReceiptDetail(
  row: any,
  creators: any[],
  sources: any[],
  userCostUsdc?: number | null,
  brainTreasuryUsdc?: number | null,
  brainPlusPreflightUsdc?: number | null,
  registryCheckFeesUsdc?: number | null,
  sourceAccessFeesUsdc?: number | null,
  registryCheckCount?: number | null,
  sourceAccessCount?: number | null,
  routeReasoning?: string | null,
  effectiveRouteTier?: string | null,
  brainRouteTierHint?: string | null,
) {
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
    // Derived from agent_trace.auto_tier_preflight (no DB column)
    userCostUsdc: userCostUsdc !== undefined ? userCostUsdc : null,
    // Brain treasury from preflight breakdown (displayed in receipt UI)
    brainTreasuryUsdc: brainTreasuryUsdc !== undefined ? brainTreasuryUsdc : null,
    // Brain + Preflight combined (brain_treasury + routing_fee)
    brainPlusPreflightUsdc: brainPlusPreflightUsdc !== undefined ? brainPlusPreflightUsdc : null,
    // Registry/source fee breakdown from preflight
    registryCheckFeesUsdc: registryCheckFeesUsdc !== undefined ? registryCheckFeesUsdc : null,
    sourceAccessFeesUsdc: sourceAccessFeesUsdc !== undefined ? sourceAccessFeesUsdc : null,
    registryCheckCount: registryCheckCount !== undefined ? registryCheckCount : null,
    sourceAccessCount: sourceAccessCount !== undefined ? sourceAccessCount : null,
    // Internal agent payments = actualSettled - userCost (graph edges beyond entry)
    internalAgentPaymentsUsdc: (() => {
      const settled = toNumber(row.actual_settled_usdc);
      const cost = userCostUsdc !== undefined ? userCostUsdc : null;
      if (settled == null || cost == null) return null;
      const diff = settled - cost;
      return Number.isFinite(diff) && diff > 0 ? diff : 0;
    })(),
    // Run Total = actualSettledUsdc (matches receipt list header amount)
    runTotalUsdc: toNumber(row.actual_settled_usdc),
    // Route reasoning — safe fields only, no raw trace
    routeReasoning: routeReasoning ?? null,
    effectiveRouteTier: effectiveRouteTier ?? null,
    brainRouteTierHint: brainRouteTierHint ?? null,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin()
    .from("paylabs_run_events")
    .select(EVENT_SAFE_FIELDS)
    .eq("discovery_run_id", discoveryRunId)
    .order("sequence", { ascending: true }) as any);

  if (error) throw new Error(`get_run_events_failed: ${error.message}`);
  return ((data || []) as Record<string, unknown>[]).map(toSafeEventProof);
}

export async function getRunReceipt(discoveryRunId: string) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select(RECEIPT_SAFE_FIELDS)
    .eq("discovery_run_id", discoveryRunId)
    .maybeSingle();

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

  const [creatorsResult, sourcesResult, runResult] = await Promise.all([
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
    // Fetch agent_trace + tier columns for userCostUsdc and route reasoning
    supabaseAdmin()
      .from("paylabs_discovery_runs")
      .select("agent_trace, effective_route_tier, brain_route_tier_hint")
      .eq("id", discoveryRunId)
      .maybeSingle(),
  ]);

  if (creatorsResult.error) throw new Error(`get_creator_receipt_rows_failed: ${creatorsResult.error.message}`);
  if (sourcesResult.error) throw new Error(`get_source_receipt_rows_failed: ${sourcesResult.error.message}`);

  // Derive userCostUsdc from agent_trace.auto_tier_preflight
  const agentTrace = (runResult.data?.agent_trace as Record<string, unknown>) || {};
  const preflight = agentTrace.auto_tier_preflight as Record<string, unknown> | undefined;
  const userCostUsdc = preflight?.status === "locked"
    ? Number(preflight.routing_fee_usdc || 0) + Number(preflight.final_entry_payment_usdc || 0)
    : null;
  
  // Extract preflight fee breakdown from agent_trace
  const lockedBreakdown = preflight?.locked_planned_cost_breakdown as Record<string, unknown> | undefined;
  const brainTreasuryUsdc = preflight?.status === "locked" && lockedBreakdown?.brain_treasury_usdc != null
    ? Number(lockedBreakdown.brain_treasury_usdc)
    : null;
  const routingFeeUsdc = preflight?.status === "locked" && preflight.routing_fee_usdc != null
    ? Number(preflight.routing_fee_usdc)
    : null;
  const brainPlusPreflightUsdc = brainTreasuryUsdc != null && routingFeeUsdc != null
    ? brainTreasuryUsdc + routingFeeUsdc
    : null;
  const registryCheckFeesUsdc = preflight?.status === "locked" && lockedBreakdown?.registry_check_fees_usdc != null
    ? Number(lockedBreakdown.registry_check_fees_usdc)
    : null;
  const sourceAccessFeesUsdc = preflight?.status === "locked" && lockedBreakdown?.source_access_fees_usdc != null
    ? Number(lockedBreakdown.source_access_fees_usdc)
    : null;
  const registryCheckCount = registryCheckFeesUsdc != null ? Math.round(registryCheckFeesUsdc / 0.000001) : null;
  const sourceAccessCount = sourceAccessFeesUsdc != null ? Math.round(sourceAccessFeesUsdc / 0.000001) : null;

  // Extract safe route reasoning from agent_trace.brain_planning
  const { routeReasoning, brainRouteTierHint } = extractSafeRouteReasoning(agentTrace);
  const effectiveRouteTier = toStringOrNull(runResult.data?.effective_route_tier);
  const resolvedBrainHint = brainRouteTierHint ?? toStringOrNull(runResult.data?.brain_route_tier_hint);

  return mapReceiptDetail(
    receipt,
    creatorsResult.data || [],
    sourcesResult.data || [],
    userCostUsdc,
    brainTreasuryUsdc,
    brainPlusPreflightUsdc,
    registryCheckFeesUsdc,
    sourceAccessFeesUsdc,
    registryCheckCount,
    sourceAccessCount,
    routeReasoning,
    effectiveRouteTier,
    resolvedBrainHint,
  );
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
    .select(PAYMENT_SAFE_FIELDS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recent_payments_failed: ${error.message}`);
  return (data || []).map(toSafePaymentProof);
}

export async function getRecentRuns(limit = 25) {
  const { data, error } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select(RUN_LIST_SAFE_FIELDS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recent_runs_failed: ${error.message}`);
  return (data || []).map(toSafeRunProof);
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