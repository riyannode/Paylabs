import { supabaseAdmin } from "@/lib/supabase/server";
import { shortAddress, formatUsdc } from "@/lib/utils";

export const dynamic = "force-dynamic";

async function getReceipts() {
  const { data } = await supabaseAdmin()
    .from("paylabs_payout_receipts")
    .select("*, lesson:paylabs_lessons(title, source:paylabs_sources(source_title))")
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

async function getUnlocks() {
  const { data } = await supabaseAdmin()
    .from("paylabs_unlocks")
    .select("*, lesson:paylabs_lessons(title)")
    .order("unlocked_at", { ascending: false })
    .limit(50);
  return data ?? [];
}

export default async function ReceiptsPage() {
  const [receipts, unlocks] = await Promise.all([getReceipts(), getUnlocks()]);

  return (
    <div>
      <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>Public Receipts</h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        All payment records from live x402 transactions on Arc testnet. No fake data.
      </p>

      {receipts.length === 0 ? (
        <div className="card" style={{ textAlign: "center", color: "var(--muted)" }}>
          No receipts yet. Payments will appear here after lesson unlocks.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {receipts.map((r: any) => (
            <div key={r.id} className="card" style={{ padding: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{r.lesson?.title || "Lesson"}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                    Ref: {r.payment_ref}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 700, color: "var(--accent-green)" }}>{formatUsdc(r.gross_amount_usdc)}</div>
                  <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                    Creator: {formatUsdc(r.creator_amount_usdc)} (85%)
                  </div>
                </div>
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: "0.5rem" }}>
                Creator: {shortAddress(r.creator_wallet)} | Platform: {shortAddress(r.platform_wallet)} | {new Date(r.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {unlocks.length > 0 && (
        <>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginTop: "2rem", marginBottom: "1rem" }}>
            Recent Unlocks
          </h2>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {unlocks.map((u: any) => (
              <div key={u.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 1rem", background: "rgba(255,255,255,0.02)", borderRadius: 8, fontSize: "0.875rem" }}>
                <span>{u.lesson?.title || u.lesson_id}</span>
                <span style={{ color: "var(--muted)" }}>
                  {shortAddress(u.user_wallet)} | {formatUsdc(u.amount_usdc)} | {new Date(u.unlocked_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
