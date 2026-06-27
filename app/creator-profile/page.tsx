import CreatorProfileClient from "./creator-profile-client";

export default function CreatorProfilePage() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <a href="/creator-dashboard" style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>← Creator Dashboard</a>
        <h1 className="page-title">Creator Profile</h1>
      </div>

      <CreatorProfileClient />
    </div>
  );
}
