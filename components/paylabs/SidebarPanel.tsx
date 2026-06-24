"use client";

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
};

export default function SidebarPanel({ analytics }: Props) {
  return (
    <aside className="pl-sidebar">
      <div className="pl-brand">PayLabs</div>

      <nav className="pl-nav">
        <a className="active" href="/">Chat</a>
        <a href="/explorer">Explorer</a>
        <a href="/source">Sources</a>
        <a href="/creator-dashboard">Creator Dashboard</a>
        <a href="/creator-profile">Creator Profile</a>
      </nav>

      {/* User Analytics */}
      <section className="pl-side-card">
        <div className="pl-side-title">User Analytics</div>
        <div className="pl-metrics">
          <div>
            <b>{analytics.uniqueUsers}</b>
            <span>Users</span>
          </div>
          <div>
            <b>{analytics.active24h}</b>
            <span>24h</span>
          </div>
          <div>
            <b>{analytics.active7d}</b>
            <span>7d</span>
          </div>
        </div>
      </section>
    </aside>
  );
}
