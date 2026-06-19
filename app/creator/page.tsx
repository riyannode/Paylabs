"use client";
import { useState } from "react";
import { short, usdc } from "@/lib/utils";

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
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <h1 className="page-title">Creator Dashboard</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Connect your wallet to see receipt-backed earnings.
        </p>
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x… creator wallet address"
            style={{ flex: 1 }}
          />
          <button onClick={loadEarnings} disabled={loading || !wallet} className="btn btn-primary">
            {loading ? "Loading…" : "Check Earnings"}
          </button>
        </div>
      </div>

      {data?.error && (
        <div className="card" style={{ color: "var(--danger)" }}>{data.error}</div>
      )}

      {data?.earnings && (
        <>
          <div className="card">
            <div className="muted" style={{ fontSize: 13 }}>Total Earned</div>
            <div className="kpi data-mono" style={{ marginTop: 4 }}>
              {data.earnings.total_creator_usdc?.toFixed(6) || "0"} USDC
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              From {data.earnings.receipt_count || 0} lesson unlocks
            </div>
          </div>

          {data.earnings.receipts?.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              {data.earnings.receipts.map((r: any) => (
                <div key={r.id} className="card" style={{ padding: "12px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{r.lesson_title || "Lesson"}</span>
                    <span className="data-mono" style={{ color: "var(--success)", fontWeight: 700 }}>
                      {usdc(r.creator_amount_usdc)}
                    </span>
                  </div>
                  <div className="muted data-mono" style={{ fontSize: 12, marginTop: 4 }}>
                    {short(r.payment_ref)} · {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
