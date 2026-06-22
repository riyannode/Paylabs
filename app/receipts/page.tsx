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

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function ReceiptsPage() {
  const receipts = await safeQuery<{
    receipt_id: string;
    discovery_run_id: string | null;
    selected_tier: string | null;
    planned_cost_usdc: number | null;
    actual_settled_usdc: number | null;
    remaining_budget_usdc: number | null;
    payment_count: number | null;
    last_tx_hash: string | null;
    safe_receipt_summary: string | null;
    created_at: string | null;
  }>(() =>
    supabaseAdmin()
      .from("paylabs_receipts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50)
  );

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Receipts</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Per-run payment receipts from x402 delegated runtime.
        </p>
      </div>

      {receipts.length === 0 ? (
        <div className="card">
          <div className="muted" style={{ textAlign: "center", padding: 48 }}>
            No receipts yet.
          </div>
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
                <th>TX Hash</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.receipt_id}>
                  <td className="muted">{timeAgo(r.created_at)}</td>
                  <td className="data-mono">{short(r.discovery_run_id)}</td>
                  <td>{r.selected_tier || "—"}</td>
                  <td className="data-mono">
                    {r.planned_cost_usdc != null ? usdc(r.planned_cost_usdc) : "—"}
                  </td>
                  <td className="data-mono" style={{ fontWeight: 600 }}>
                    {usdc(r.actual_settled_usdc)}
                  </td>
                  <td className="data-mono">
                    {r.remaining_budget_usdc != null ? usdc(r.remaining_budget_usdc) : "—"}
                  </td>
                  <td className="data-mono">{r.payment_count ?? 0}</td>
                  <td className="data-mono" style={{ fontSize: 11 }}>
                    {r.last_tx_hash ? short(r.last_tx_hash) : "—"}
                  </td>
                  <td
                    className="muted"
                    style={{
                      fontSize: 11,
                      maxWidth: 250,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.safe_receipt_summary || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
