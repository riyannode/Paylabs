"use client";

export default function CreatorPage() {
  return (
    <div style={{ display: "grid", gap: 24 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Creator Dashboard</h1>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Register Waitlist</h2>
        <p className="muted" style={{ fontSize: 14, maxWidth: 400, margin: "0 auto" }}>
          Creator earnings dashboard is under development. Connect your wallet later to track source payment earnings.
        </p>
      </div>
    </div>
  );
}
