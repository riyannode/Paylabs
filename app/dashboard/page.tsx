import { supabaseAdmin } from "@/lib/supabase/server";
import { short, shortUrl, usdc } from "@/lib/utils";

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
    </div>
  );
}
