"use client";

import CreatorWalletPanel from "@/components/paylabs/CreatorWalletPanel";

export default function CreatorPage() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Creator Dashboard</h1>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Creator Wallet</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
          Connect your wallet to manage your creator profile and track source payment earnings.
        </p>
        <CreatorWalletPanel />
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Earnings Dashboard</h2>
        <p className="muted" style={{ fontSize: 14, maxWidth: 400, margin: "0 auto" }}>
          Creator earnings tracking is under development. Connect your wallet above to get started.
        </p>
      </div>
    </div>
  );
}
