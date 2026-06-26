"use client";

import CreatorWalletPanel from "@/components/paylabs/CreatorWalletPanel";

export default function CreatorPage() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Creator Dashboard</h1>
      </div>

      <div className="card" style={{ padding: "24px" }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Creator Wallet</h2>
        <p className="muted" style={{ fontSize: 14, marginBottom: 16 }}>
          Connect your Circle wallet to receive creator payouts from source attribution.
        </p>
        <CreatorWalletPanel />
      </div>
    </div>
  );
}
