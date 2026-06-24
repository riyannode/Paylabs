"use client";

export default function CreatorProfilePage() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Chat</a>
        <h1 className="page-title">Creator Profile</h1>
      </div>

      <div className="card" style={{ textAlign: "center", padding: "64px 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Coming Soon</h2>
        <p className="muted" style={{ fontSize: 14, maxWidth: 400, margin: "0 auto" }}>
          Creator profile management is under development. Connect your wallet later to manage your creator profile and earnings.
        </p>
      </div>
    </div>
  );
}
