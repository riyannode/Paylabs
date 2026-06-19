"use client";
import { useState } from "react";

export default function CreatorPage() {
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function loadEarnings() {
    if (!wallet) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/paylabs/creator?wallet=${encodeURIComponent(wallet)}`);
      const json = await res.json();
      setData(json);
    } catch (e: any) {
      setData({ error: e.message });
    }
    setLoading(false);
  }

  return (
    <div>
      <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.5rem" }}>Creator Dashboard</h1>
      <p style={{ color: "var(--muted)", marginBottom: "2rem" }}>
        Connect your wallet to see receipt-backed earnings from lesson unlocks.
      </p>

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          <input
            className="input"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x... creator wallet address"
            style={{ flex: 1 }}
          />
          <button onClick={loadEarnings} disabled={loading || !wallet} className="btn btn-primary">
            {loading ? "Loading..." : "Check Earnings"}
          </button>
        </div>
      </div>

      {data?.error && (
        <div className="card" style={{ color: "#ef4444" }}>{data.error}</div>
      )}

      {data?.earnings && (
        <div>
          <div className="card" style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "2rem", fontWeight: 700, color: "var(--accent-green)" }}>
              {data.earnings.total_creator_usdc?.toFixed(6) || "0"} USDC
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
              Total earned from {data.earnings.receipt_count || 0} lesson unlocks
            </div>
          </div>

          {data.earnings.receipts?.length > 0 && (
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {data.earnings.receipts.map((r: any) => (
                <div key={r.id} className="card" style={{ padding: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.lesson_title || "Lesson"}</span>
                    <span style={{ color: "var(--accent-green)" }}>{r.creator_amount_usdc} USDC</span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                    Gross: {r.gross_amount_usdc} | Platform: {r.platform_amount_usdc} | Treasury: {r.treasury_amount_usdc}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                    {r.payment_ref} | {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
