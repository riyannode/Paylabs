import { supabaseAdmin } from "@/lib/supabase/server";
import { short, shortUrl, usdc } from "@/lib/utils";
import BatchResolverLink from "@/components/paylabs/BatchResolverLink";

async function getRecentX402Payments(limit = 50) {
  const { data } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

async function getRecentReceipts(limit = 25) {
  const { data } = await supabaseAdmin()
    .from("paylabs_receipts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

async function getLastTx() {
  const { data } = await supabaseAdmin()
    .from("paylabs_service_payment_events")
    .select("*")
    .not("tx_hash", "is", null)
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
    rsshubRoutes,
    feedItems,
    sourcePayments,
    totalSourcePaymentUsdc,
    discoveryRuns,
    routeRows,
    feedItemRows,
    sourcePaymentRows,
    discoveryRunRows,
    x402PaymentRows,
    receiptRows,
    servicePaymentCount,
    receiptCount,
    lastTxRow,
    totalSettledUsdc,
  ] = await Promise.all([
    safeCount("paylabs_rsshub_routes", (q: any) => q.eq("is_active", true)),
    safeCount("paylabs_feed_items", (q: any) => q.eq("is_active", true)),
    safeCount("paylabs_source_payments", (q: any) =>
      q.eq("status", "completed")
    ),
    safeSum("paylabs_source_payments", "amount_usdc", (q: any) =>
      q.eq("status", "completed")
    ),
    safeCount("paylabs_discovery_runs"),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_rsshub_routes")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_feed_items")
        .select(
          "id, title, summary, canonical_url, author_name, publisher, published_at, creator_wallet, is_monetized, price_per_citation_usdc, price_per_unlock_usdc, normalized_sha256, is_active"
        )
        .eq("is_active", true)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_source_payments")
        .select("*")
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_discovery_runs")
        .select("id, user_wallet, goal, route_tier, status, candidate_count, eligible_source_count, unclaimed_source_count, created_at, agent_trace")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    // x402 Service Payments
    getRecentX402Payments(50),
    // Receipts
    getRecentReceipts(25),
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
          { label: "Discovery Runs", value: discoveryRuns },
          { label: "RSSHub Routes", value: rsshubRoutes },
          { label: "Feed Items", value: feedItems },
          { label: "Source Payments", value: sourcePayments },
          { label: "Source Payouts", value: usdc(totalSourcePaymentUsdc) },
          { label: "x402 Service Payments", value: servicePaymentCount },
          { label: "Receipts", value: receiptCount },
          { label: "Settled USDC", value: usdc(totalSettledUsdc) },
          { label: "Last TX", value: lastTxRow?.tx_hash ? short(lastTxRow.tx_hash) : "tx unavailable" },
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



      {/* ─── RSSHub Routes Table ───────────────────────────── */}
      <section className="card">
        <h2 className="section-title">RSSHub Routes</h2>
        {routeRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No RSSHub routes configured.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Route Path</th>
                  <th>Base URL</th>
                  <th>Status</th>
                  <th>Citation Price</th>
                  <th>Last Synced</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {routeRows.map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td className="data-mono">{r.route_path}</td>
                    <td className="muted">
                      {shortUrl(r.rsshub_base_url, 30)}
                    </td>
                    <td>
                      <span className={`badge ${r.is_monetized ? "badge-success" : ""}`} style={!r.is_monetized ? { fontSize: 10 } : undefined}>
                        {r.is_monetized ? "Monetized" : "Sample"}
                      </span>
                    </td>
                    <td className="data-mono">
                      {r.is_monetized ? usdc(r.default_price_per_citation_usdc) : "Not monetized"}
                    </td>
                    <td className="muted">
                      {r.last_synced_at ? timeAgo(r.last_synced_at) : "never"}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          r.is_active ? "badge-success" : "badge-warning"
                        }`}
                      >
                        {r.is_active ? "active" : "inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Feed Items Table ──────────────────────────────── */}
      <section className="card">
        <h2 className="section-title">RSSHub Feed Items</h2>
        {feedItemRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No feed items yet. Run sync to import from RSSHub.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Author</th>
                  <th>Source URL</th>
                  <th>Status</th>
                  <th>Citation Price</th>
                  <th>Hash</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {feedItemRows.map((f: any) => (
                  <tr key={f.id}>
                    <td style={{ fontWeight: 600 }}>
                      {f.title || "(untitled)"}
                    </td>
                    <td>{f.author_name || f.publisher || "—"}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {f.canonical_url ? (
                        <a href={f.canonical_url} target="_blank" rel="noopener noreferrer">
                          {shortUrl(f.canonical_url, 35)}
                        </a>
                      ) : shortUrl(f.canonical_url, 35)}
                    </td>
                    <td>
                      <span className={`badge ${f.is_monetized ? "badge-success" : ""}`} style={!f.is_monetized ? { fontSize: 10 } : undefined}>
                        {f.is_monetized ? "Monetized" : "Sample"}
                      </span>
                    </td>
                    <td className="data-mono">
                      {f.is_monetized ? usdc(f.price_per_citation_usdc) : "Not monetized"}
                    </td>
                    <td className="data-mono" style={{ fontSize: 11 }}>
                      {f.normalized_sha256
                        ? short(f.normalized_sha256)
                        : "—"}
                    </td>
                    <td className="muted">
                      {f.published_at ? timeAgo(f.published_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Source Payments Table ──────────────────────────── */}
      <section className="card">
        <h2 className="section-title">Source Payments</h2>
        {sourcePaymentRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No source payments yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Source URL</th>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Kind</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sourcePaymentRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.user_wallet)}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {r.source_url ? (
                        <a href={r.source_url} target="_blank" rel="noopener noreferrer">
                          {shortUrl(r.source_url, 35)}
                        </a>
                      ) : shortUrl(r.source_url, 35)}
                    </td>
                    <td>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {r.creator_wallet ? "Creator" : "Treasury"}
                      </span>
                    </td>
                    <td className="data-mono">{usdc(r.amount_usdc)}</td>
                    <td>{r.payment_kind}</td>
                    <td className="data-mono">{short(r.payment_id)}</td>
                    <td>
                      <span
                        className={`badge ${
                          r.status === "completed"
                            ? "badge-success"
                            : r.status === "failed"
                            ? "badge-danger"
                            : "badge-warning"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Discovery Runs Table ──────────────────────────── */}
      <section className="card">
        <h2 className="section-title">Discovery Runs</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          PayLabs charges a discovery fee for AI-powered source routing. If a source is not yet claimed by a creator, the fee covers agent compute, indexing, and attribution tracking. Creator payouts only begin after ownership is verified.
        </p>
        {discoveryRunRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No discovery runs yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Goal</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Candidates</th>
                  <th>Eligible</th>
                  <th>Unclaimed</th>
                </tr>
              </thead>
              <tbody>
                {discoveryRunRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.user_wallet)}</td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.goal}
                    </td>
                    <td>{r.route_tier}</td>
                    <td>
                      <span
                        className={`badge ${
                          r.status === "paid_path_available"
                            ? "badge-success"
                            : r.status === "completed"
                            ? "badge-success"
                            : r.status === "discovery_only"
                            ? "badge-warning"
                            : "badge-danger"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="data-mono">{r.candidate_count}</td>
                    <td className="data-mono">{r.eligible_source_count}</td>
                    <td className="data-mono">{r.unclaimed_source_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── x402 Service Payments Table ───────────────────── */}
      <section className="card">
        <h2 className="section-title">x402 Service Payments</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          Official Circle x402 delegated-runtime service payment edges. Each edge represents a paid service call in the payment graph.
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

      {/* ─── Receipts Table ─────────────────────────────────── */}
      <section className="card">
        <h2 className="section-title">Receipts</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          Per-run receipts from official Circle x402 delegated-runtime payments. Settled amount equals sum of paid payment graph edges.
        </p>
        {receiptRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No receipts yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run ID</th>
                  <th>Tier</th>
                  <th>Planned</th>
                  <th>Settled</th>
                  <th>Remaining</th>
                  <th>Payments</th>
                  <th>Payment Links</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {receiptRows.map((r: any) => (
                  <tr key={r.receipt_id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.discovery_run_id)}</td>
                    <td>{r.selected_tier}</td>
                    <td className="data-mono">{r.planned_cost_usdc != null ? usdc(r.planned_cost_usdc) : "—"}</td>
                    <td className="data-mono" style={{ fontWeight: 600 }}>{usdc(r.actual_settled_usdc)}</td>
                    <td className="data-mono">{r.remaining_budget_usdc != null ? usdc(r.remaining_budget_usdc) : "—"}</td>
                    <td className="data-mono">{r.payment_count}</td>
                    <td>
                      <BatchResolverLink
                        runId={r.discovery_run_id}
                        initialBatchExplorerUrl={r.last_batch_explorer_url}
                        initialBatchTxHash={r.last_batch_tx_hash}
                        directExplorerUrl={r.last_explorer_url}
                        directTxHash={r.last_tx_hash}
                      />
                    </td>
                    <td className="muted" style={{ fontSize: 11, maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.safe_receipt_summary || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>



    </div>
  );
}
