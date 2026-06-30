import { supabaseAdmin } from "@/lib/supabase/server";
import { short, usdc } from "@/lib/utils";
import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";
import BatchResolverLink from "@/components/paylabs/BatchResolverLink";
import SubPageMobileNav from "@/components/paylabs/SubPageMobileNav";

async function getRecentX402Payments(limit = 50) {
  const { data } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("discovery_run_id, node_type, seller, status, mode, amount_usdc, tx_hash, explorer_url, settlement_id, settlement_url, batch_tx_hash, batch_explorer_url, safe_summary, error, created_at")
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
          { label: "Settled USDC", value: usdc(totalSettledUsdc) },
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
                {x402PaymentRows.map((r: any, i: number) => (
                  <tr key={`${r.discovery_run_id}-${i}`}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.discovery_run_id)}</td>
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




    </div>
    </>
  );
}