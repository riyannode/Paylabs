import { supabaseAdmin } from "@/lib/supabase/server";
import { short, usdc } from "@/lib/utils";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";
import BatchResolverLink from "@/components/paylabs/BatchResolverLink";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";

async function getRecentX402Payments(limit = 50) {
  const { data } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

async function getLastTx() {
  const { data } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("last_batch_tx_hash, last_batch_explorer_url, created_at")
    .not("last_batch_tx_hash", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

export const dynamic = "force-dynamic";

async function safeQuery<T>(
  fn: () => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  try {
    const { data, error } = await fn();
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

async function safeCount(
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    let q: any = supabaseAdmin()
      .from(table)
      .select("*", { count: "exact", head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function safeSum(
  table: string,
  column: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    const rows = await safeQuery<any>(() => {
      let q: any = supabaseAdmin().from(table).select(column);
      if (filter) q = filter(q);
      return q.limit(1000);
    });
    return rows.reduce((sum: number, row: any) => sum + Number(row[column] || 0), 0);
  } catch {
    return 0;
  }
}
// ─── Payout Ledger ──────────────────────────────────────────

async function getPayoutLedgerRows(limit = 100) {
  return safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select(
        "discovery_run_id,payout_type,payout_subject_id,status,amount_usdc,amount_atomic,reason,tx_hash,explorer_url,batch_tx_hash,batch_explorer_url,created_at"
      )
      .order("created_at", { ascending: false })
      .limit(limit)
  );
}

async function getCreatorPaidUsdc(): Promise<number> {
  const rows = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "creator_share")
      .in("status", ["paid", "gateway_accepted"])
      .limit(1000)
  );
  return rows.reduce((s, r) => s + Number(r.amount_usdc || 0), 0);
}

async function getBotShareUsdc(): Promise<number> {
  const rows = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "bot_share")
      .in("status", ["paid", "gateway_accepted"])
      .limit(1000)
  );
  return rows.reduce((s, r) => s + Number(r.amount_usdc || 0), 0);
}

async function getServiceShareUsdc(): Promise<number> {
  const rows = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "service_share")
      .in("status", ["paid", "gateway_accepted"])
      .limit(1000)
  );
  return rows.reduce((s, r) => s + Number(r.amount_usdc || 0), 0);
}

async function getTreasuryUnallocatedUsdc(): Promise<number> {
  const unalloc = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "unallocated_reserve")
      .eq("status", "skipped")
      .limit(1000)
  );
  const retained = await safeQuery<any>(() =>
    supabaseAdmin()
      .from("paylabs_payout_ledger")
      .select("amount_usdc")
      .eq("payout_type", "treasury_retained")
      .limit(1000)
  );
  return [...unalloc, ...retained].reduce(
    (s, r) => s + Number(r.amount_usdc || 0),
    0
  );
}

function payoutTypeLabel(t: string): string {
  switch (t) {
    case "creator_share":
      return "Creator";
    case "bot_share":
      return "Bot Share";
    case "service_share":
      return "Service Share";
    case "unallocated_reserve":
      return "Treasury / Unallocated";
    case "treasury_retained":
      return "Treasury Retained";
    default:
      return t;
  }
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export default async function DashboardPage() {
  const [
    x402PaymentRows,
    servicePaymentCount,
    receiptCount,
    lastTxRow,
    totalSettledUsdc,
    // Payout ledger
    creatorPaidUsdc,
    botShareUsdc,
    serviceShareUsdc,
    treasuryUnallocatedUsdc,
    payoutLedgerCount,
    payoutLedgerRows,
  ] = await Promise.all([
    // x402 Service Payments
    getRecentX402Payments(50),
    // Counts
    safeCount("paylabs_service_payment_events"),
    safeCount("paylabs_receipts"),
    // Last TX
    getLastTx(),
    // Total settled USDC
    safeSum("paylabs_receipts", "actual_settled_usdc"),
    // Payout ledger aggregations
    getCreatorPaidUsdc(),
    getBotShareUsdc(),
    getServiceShareUsdc(),
    getTreasuryUnallocatedUsdc(),
    safeCount("paylabs_payout_ledger"),
    getPayoutLedgerRows(100),
  ]);

  // ─── User stats (unique wallets) ───
  const [
    totalUsers,
    recentUsers7d,
    recentUsers24h,

  ] = await Promise.all([
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
    safeQuery<{ user_wallet: string }>(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("user_wallet")
        .gte("created_at", new Date(Date.now() - 86400000).toISOString())
        .limit(10000)
    ).then((rows) => new Set(rows.map((r) => r.user_wallet?.toLowerCase()).filter(Boolean)).size),
  ]);

  return (
    <>
      <SubPageMobileNav />
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <a href="/" className="pl-back-btn">← Back to Chat</a>
        <h1 className="page-title">Explorer</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Transaction activity
        </p>
      </div>

      {/* ─── KPI Cards ──────────────────────────────────────── */}
      <div className="grid-4">
        {[
          { label: "Unique Users", value: totalUsers },
          { label: "Users (24h)", value: recentUsers24h },
          { label: "Users (7d)", value: recentUsers7d },
          { label: "x402 Service Payments", value: servicePaymentCount },
          { label: "Receipts", value: receiptCount },
          { label: "Platform x402 Volume", value: usdc(totalSettledUsdc) },
          {
            label: "Last TX",
            value: (() => {
              const hash = lastTxRow?.last_batch_tx_hash as string | null;
              const href = hrefFromTx(lastTxRow?.last_batch_explorer_url, hash);
              return href && hash ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--success, #22c55e)", textDecoration: "none", fontWeight: 600 }}
                >
                  {short(hash)} ↗
                </a>
              ) : (
                <span style={{ color: "var(--muted, #888)" }}>Check tx</span>
              );
            })(),
          },
          // Payout ledger KPIs
          { label: "Creator Paid", value: usdc(creatorPaidUsdc) },
          { label: "Bot Share", value: usdc(botShareUsdc) },
          { label: "Service Share", value: usdc(serviceShareUsdc) },
          { label: "Treasury / Unallocated", value: usdc(treasuryUnallocatedUsdc) },
          { label: "Payout Ledger Rows", value: payoutLedgerCount },
        ].map((kpi) => (
          <div className="card" key={kpi.label}>
            <div className="muted" style={{ fontSize: 13 }}>
              {kpi.label}
            </div>
            <div className="kpi" style={{ marginTop: 4 }}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>



      {/* ─── x402 Service Payments Table ───────────────────── */}
      <section className="card">
        <h2 className="section-title">x402 Service Payments</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          x402 paid service calls from PayLabs runs.
        </p>
        {x402PaymentRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No x402 service payments yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run ID</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th>Node Type</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Mode</th>
                  <th>Payment Visibility</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {x402PaymentRows.map((r: any) => (
                  <tr key={r.event_id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.discovery_run_id)}</td>
                    <td className="data-mono" style={{ fontSize: 11 }}>{r.buyer}</td>
                    <td className="data-mono" style={{ fontSize: 11 }}>{r.seller}</td>
                    <td>
                      <span className={`badge ${
                        r.node_type === "brain" ? "badge-success" :
                        r.node_type === "macro_node" ? "badge-warning" : ""
                      }`} style={{ fontSize: 10 }}>
                        {r.node_type}
                      </span>
                    </td>
                    <td className="data-mono">{usdc(r.amount_usdc)}</td>
                    <td>
                      <span className={`badge ${
                        r.status === "paid" ? "badge-success" :
                        r.status === "failed" ? "badge-danger" : "badge-warning"
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 11 }}>{r.mode}</td>
                    <td>
                      <BatchResolverLink
                        runId={r.discovery_run_id}
                        initialBatchExplorerUrl={r.batch_explorer_url}
                        initialBatchTxHash={r.batch_tx_hash}
                        directExplorerUrl={r.explorer_url}
                        directTxHash={r.tx_hash}
                      />
                    </td>
                    <td className="muted" style={{ fontSize: 10, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.error || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {/* ─── Creator Distribution Ledger ───────────────────── */}
      <section className="card">
        <h2 className="section-title">Creator Distribution Ledger</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          Creator payouts, bot/service shares, and Treasury / Unallocated amounts from PayLabs payout ledger.
        </p>
        {payoutLedgerRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No payout ledger entries yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run ID</th>
                  <th>Type</th>
                  <th>Subject</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Visibility</th>
                </tr>
              </thead>
              <tbody>
                {payoutLedgerRows.map((r: any) => {
                  const hasTx = !!(r.tx_hash || r.explorer_url || r.batch_tx_hash || r.batch_explorer_url);
                  const isSkippedTreasury = r.status === "skipped" && (r.payout_type === "unallocated_reserve" || r.payout_type === "treasury_retained");
                  return (
                    <tr key={`${r.discovery_run_id}-${r.payout_type}-${r.payout_subject_id}`}>
                      <td className="muted">{timeAgo(r.created_at)}</td>
                      <td className="data-mono">{short(r.discovery_run_id)}</td>
                      <td>
                        <span className={`badge ${
                          r.payout_type === "creator_share" ? "badge-success" :
                          r.payout_type === "unallocated_reserve" || r.payout_type === "treasury_retained" ? "badge-warning" :
                          ""
                        }`} style={{ fontSize: 10 }}>
                          {payoutTypeLabel(r.payout_type)}
                        </span>
                      </td>
                      <td className="data-mono" style={{ fontSize: 11 }}>{short(r.payout_subject_id)}</td>
                      <td className="data-mono">{usdc(r.amount_usdc)}</td>
                      <td>
                        <span className={`badge ${
                          r.status === "paid" || r.status === "gateway_accepted" ? "badge-success" :
                          r.status === "failed" ? "badge-danger" :
                          r.status === "skipped" ? "badge-warning" :
                          ""
                        }`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.reason || "—"}
                      </td>
                      <td>
                        {hasTx ? (
                          <BatchResolverLink
                            runId={r.discovery_run_id}
                            initialBatchExplorerUrl={r.batch_explorer_url}
                            initialBatchTxHash={r.batch_tx_hash}
                            directExplorerUrl={r.explorer_url}
                            directTxHash={r.tx_hash}
                          />
                        ) : isSkippedTreasury ? (
                          <span className="muted" style={{ fontSize: 11 }}>No transfer</span>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>





    </div>
    </>
  );
}