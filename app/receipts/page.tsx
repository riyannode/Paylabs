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

export default async function ReceiptsPage() {
  const [payouts, unlocks] = await Promise.all([
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_payout_receipts")
        .select("*, lesson:paylabs_lessons(title)")
        .order("created_at", { ascending: false })
        .limit(50)
    ),
    safeQuery(() =>
      supabaseAdmin()
        .from("paylabs_unlocks")
        .select("*, lesson:paylabs_lessons(title)")
        .order("unlocked_at", { ascending: false })
        .limit(50)
    ),
  ]);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 className="page-title">Payments</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Live payment records from x402 transactions on Arc testnet.
        </p>
      </div>

      {/* Creator Payouts */}
      <section className="card">
        <h2 className="section-title">Creator Payouts</h2>
        {payouts.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No payouts yet.</div>
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
                {payouts.map((p: any) => (
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

      {/* Lesson Unlocks */}
      <section className="card">
        <h2 className="section-title">Lesson Unlocks</h2>
        {unlocks.length === 0 ? (
          <div className="muted" style={{ textAlign: "center", padding: 24 }}>No unlocks yet.</div>
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
                {unlocks.map((u: any) => (
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
    </div>
  );
}
