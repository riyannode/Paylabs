import { supabaseAdmin } from "@/lib/supabase/server";
import { short, usdc } from "@/lib/utils";

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
    publishedLessons,
    creators,
    unlocks,
    creatorPayouts,
    routeTolls,
    agentPayments,
    learningPaths,
    totalRouteTollUsdc,
    totalAgentServiceUsdc,
    totalCreatorPayoutUsdc,
    routeTollRows,
    agentServiceRows,
    unlockRows,
    payoutRows,
    lessonRows,
  ] = await Promise.all([
    safeCount("paylabs_lessons", (q: any) => q.eq("is_published", true)),
    safeCount("paylabs_creators"),
    safeCount("paylabs_unlocks"),
    safeCount("paylabs_payout_receipts"),
    safeCount("paylabs_route_toll_calls", (q: any) => q.eq("status", "completed")),
    safeCount("paylabs_agent_service_calls", (q: any) => q.eq("status", "completed")),
    safeCount("paylabs_learning_paths"),
    safeSum("paylabs_route_toll_calls", "amount_usdc", (q: any) =>
      q.eq("status", "completed")
    ),
    safeSum("paylabs_agent_service_calls", "amount_usdc", (q: any) =>
      q.eq("status", "completed")
    ),
    safeSum("paylabs_payout_receipts", "creator_amount_usdc"),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_route_toll_calls")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_agent_service_calls")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_unlocks")
        .select("*, lesson:paylabs_lessons(title)")
        .order("unlocked_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_payout_receipts")
        .select("*, lesson:paylabs_lessons(title)")
        .order("created_at", { ascending: false })
        .limit(25)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_lessons")
        .select(
          "id, title, slug, price_usdc, difficulty, is_published, creator:paylabs_creators(display_name), source:paylabs_sources(source_title)"
        )
        .eq("is_published", true)
        .order("price_usdc", { ascending: true })
        .limit(50)
    ),
  ]);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 className="page-title">Dashboard</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Live PayLabs activity.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid-4">
        {[
          { label: "Lessons", value: publishedLessons },
          { label: "Route Tolls", value: routeTolls },
          { label: "Agent Payments", value: agentPayments },
          { label: "Creator Payouts", value: creatorPayouts },
        ].map((kpi) => (
          <div className="card" key={kpi.label}>
            <div className="muted" style={{ fontSize: 13 }}>{kpi.label}</div>
            <div className="kpi" style={{ marginTop: 4 }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* USDC totals */}
      <div className="grid-3">
        {[
          { label: "Total Route Tolls", value: usdc(totalRouteTollUsdc) },
          { label: "Total Agent Services", value: usdc(totalAgentServiceUsdc) },
          { label: "Total Creator Payouts", value: usdc(totalCreatorPayoutUsdc) },
        ].map((t) => (
          <div className="card-soft" key={t.label}>
            <div className="muted" style={{ fontSize: 12 }}>{t.label}</div>
            <div className="data-mono" style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{t.value}</div>
          </div>
        ))}
      </div>

      {/* Route Toll Payments */}
      <section className="card">
        <h2 className="section-title">Route Toll Payments</h2>
        {routeTollRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No records yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Route</th>
                  <th>Amount</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {routeTollRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.user_wallet)}</td>
                    <td>{r.route_label || r.route_tier}</td>
                    <td className="data-mono">{usdc(r.amount_usdc)}</td>
                    <td className="data-mono">{short(r.payment_id)}</td>
                    <td>
                      <span className={`badge ${r.status === "completed" ? "badge-success" : r.status === "failed" ? "badge-danger" : "badge-warning"}`}>
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

      {/* Agent Service Payments */}
      <section className="card">
        <h2 className="section-title">Agent Service Payments</h2>
        {agentServiceRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No records yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Buyer Agent</th>
                  <th>Provider Agent</th>
                  <th>Amount</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {agentServiceRows.map((r: any) => (
                  <tr key={r.id}>
                    <td className="muted">{timeAgo(r.created_at)}</td>
                    <td className="data-mono">{short(r.buyer_agent_id)}</td>
                    <td className="data-mono">{short(r.provider_agent_id)}</td>
                    <td className="data-mono">{usdc(r.amount_usdc)}</td>
                    <td className="data-mono">{short(r.payment_id)}</td>
                    <td>
                      <span className={`badge ${r.status === "completed" ? "badge-success" : r.status === "failed" ? "badge-danger" : "badge-warning"}`}>
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

      {/* Lesson Unlocks */}
      <section className="card">
        <h2 className="section-title">Lesson Unlocks</h2>
        {unlockRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No records yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Lesson</th>
                  <th>Amount</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {unlockRows.map((u: any) => (
                  <tr key={u.id}>
                    <td className="muted">{timeAgo(u.unlocked_at)}</td>
                    <td className="data-mono">{short(u.user_wallet)}</td>
                    <td>{u.lesson?.title || short(u.lesson_id)}</td>
                    <td className="data-mono">{usdc(u.amount_usdc)}</td>
                    <td className="data-mono">{short(u.payment_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Creator Payouts */}
      <section className="card">
        <h2 className="section-title">Creator Payouts</h2>
        {payoutRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No records yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Lesson</th>
                  <th>Creator</th>
                  <th>Gross</th>
                  <th>Creator Share</th>
                  <th>Ref</th>
                </tr>
              </thead>
              <tbody>
                {payoutRows.map((p: any) => (
                  <tr key={p.id}>
                    <td className="muted">{timeAgo(p.created_at)}</td>
                    <td>{p.lesson?.title || "—"}</td>
                    <td className="data-mono">{short(p.creator_wallet)}</td>
                    <td className="data-mono">{usdc(p.gross_amount_usdc)}</td>
                    <td className="data-mono">{usdc(p.creator_amount_usdc)}</td>
                    <td className="data-mono">{short(p.payment_ref)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Published Lessons */}
      <section className="card">
        <h2 className="section-title">Published Lessons</h2>
        {lessonRows.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No records yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Difficulty</th>
                  <th>Price</th>
                  <th>Creator</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {lessonRows.map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      <a href={`/learn/${l.slug}`} style={{ fontWeight: 600 }}>{l.title}</a>
                    </td>
                    <td>
                      <span className={`badge badge-${l.difficulty}`}>{l.difficulty}</span>
                    </td>
                    <td className="data-mono">{usdc(l.price_usdc)}</td>
                    <td>{l.creator?.display_name || "—"}</td>
                    <td className="muted">{l.source?.source_title || "—"}</td>
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
