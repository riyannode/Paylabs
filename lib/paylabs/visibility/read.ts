import { supabaseAdmin } from "@/lib/supabase/server";

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
