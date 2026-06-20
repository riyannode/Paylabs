import { supabaseAdmin } from "@/lib/supabase/server";
import { short, shortUrl, usdc } from "@/lib/utils";
import { getRecentNanopayments, getRecentBatchSettlements } from "@/lib/paylabs/nanopayment-service";

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
      .select("id", { count: "exact", head: true });
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
    nanopaymentRows,
    batchSettlementRows,
    nanopaymentCount,
    batchSettlementCount,
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
          "id, title, summary, canonical_url, author_name, publisher, published_at, creator_wallet, price_per_citation_usdc, price_per_unlock_usdc, normalized_sha256, is_active"
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
        .select("id, user_wallet, goal, route_tier, status, candidate_count, eligible_source_count, unclaimed_source_count, created_at")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    // Nanopayments
    getRecentNanopayments(50),
    getRecentBatchSettlements(25),
    safeCount("paylabs_agent_nanopayments"),
    safeCount("paylabs_agent_batch_settlements"),
  ]);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          RSSHub-first source feed activity.
        </p>
      </div>

      {/* ─── RSSHub KPI Cards ──────────────────────────────── */}
      <div className="grid-4">
        {[
          { label: "RSSHub Routes", value: rsshubRoutes },
          { label: "Feed Items", value: feedItems },
          { label: "Source Payments", value: sourcePayments },
          { label: "Source Payouts", value: usdc(totalSourcePaymentUsdc) },
          { label: "Discovery Runs", value: discoveryRuns },
          { label: "Agent Nanopayments", value: nanopaymentCount },
          { label: "Batch Settlements", value: batchSettlementCount },
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
                  <th>Creator</th>
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
                    <td className="data-mono">
                      {short(r.creator_wallet)}
                    </td>
                    <td className="data-mono">
                      {usdc(r.default_price_per_citation_usdc)}
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
                  <th>Creator</th>
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
                      {shortUrl(f.canonical_url, 35)}
                    </td>
                    <td className="data-mono">
                      {short(f.creator_wallet)}
                    </td>
                    <td className="data-mono">
                      {usdc(f.price_per_citation_usdc)}
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
                  <th>Creator</th>
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
                      {shortUrl(r.source_url, 35)}
                    </td>
                    <td className="data-mono">
                      {short(r.creator_wallet)}
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

      {/* ─── Agent Nanopayments Table ──────────────────────── */}
      <section className="card">
        <h2 className="section-title">Agent Nanopayments</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16, padding: "8px 12px", borderLeft: "3px solid var(--accent, #6366f1)", background: "var(--accent-bg, rgba(99,102,241,0.06))" }}>
          Each paid agent capability call costs exactly 0.000001 USDC. 7 agents per discovery run.
        </p>
        {nanopaymentRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No agent nanopayments yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run ID</th>
                  <th>Agent Name</th>
                  <th>Payer</th>
                  <th>Payee</th>
                  <th>Route Tier</th>
                  <th>Settlement</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Receipt</th>
                  <th>Payment Ref</th>
                  <th>Settlement Ref</th>
                </tr>
              </thead>
              <tbody>
                {nanopaymentRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.discovery_run_id)}</td>
                    <td style={{ fontWeight: 600 }}>{r.agent_name}</td>
                    <td className="data-mono">{short(r.payer_agent)}</td>
                    <td className="data-mono">{short(r.payee_agent)}</td>
                    <td>{r.route_tier}</td>
                    <td>
                      <span className={`badge ${r.settlement_mode === "nano" ? "badge-success" : "badge-warning"}`}>
                        {r.settlement_mode}
                      </span>
                    </td>
                    <td className="data-mono">{usdc(r.price_usdc)}</td>
                    <td>
                      <span className={`badge ${
                        r.status === "paid" || r.status === "completed"
                          ? "badge-success"
                          : r.status === "failed"
                          ? "badge-danger"
                          : "badge-warning"
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.receipt_url ? (
                        <a href={r.receipt_url} className="data-mono" style={{ fontSize: 11, color: "var(--accent, #6366f1)" }}>
                          {short(r.receipt_id)}
                        </a>
                      ) : "—"}
                    </td>
                    <td className="data-mono" style={{ fontSize: 11 }}>
                      {r.x402_payment_ref ? short(r.x402_payment_ref) : "—"}
                    </td>
                    <td className="data-mono" style={{ fontSize: 11 }}>
                      {r.x402_settlement_ref ? short(r.x402_settlement_ref) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Batch Settlements Table ───────────────────────── */}
      <section className="card">
        <h2 className="section-title">Agent Batch Settlements</h2>
        {batchSettlementRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>
            No batch settlements yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Run ID</th>
                  <th>Route Tier</th>
                  <th>Agent Count</th>
                  <th>Agent Total</th>
                  <th>Treasury Fee</th>
                  <th>Gateway Buffer</th>
                  <th>Status</th>
                  <th>Batch ID</th>
                </tr>
              </thead>
              <tbody>
                {batchSettlementRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.discovery_run_id)}</td>
                    <td>{r.route_tier}</td>
                    <td className="data-mono">{r.agent_count}</td>
                    <td className="data-mono">{usdc(r.agent_total_usdc)}</td>
                    <td className="data-mono">{usdc(r.treasury_fee_usdc)}</td>
                    <td className="data-mono">{usdc(r.gateway_buffer_usdc)}</td>
                    <td>
                      <span className={`badge ${
                        r.status === "paid"
                          ? "badge-success"
                          : r.status === "failed"
                          ? "badge-danger"
                          : "badge-warning"
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="data-mono" style={{ fontSize: 11 }}>
                      {r.circle_batch_id ? short(r.circle_batch_id) : "—"}
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
