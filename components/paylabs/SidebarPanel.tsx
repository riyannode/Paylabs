"use client";

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
  topWallet?: { address: string; runs: number } | null;
};

type Props = {
  analytics: Analytics;
};

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

export default function SidebarPanel({ analytics }: Props) {
  return (
    <aside className="pl-sidebar">
      <div className="pl-brand">PayLabs</div>

      <nav className="pl-nav">
        <a className="active" href="/">Chat</a>
        <a href="/dashboard">Explorer</a>
        <a href="/sources">Sources</a>
        <a href="/creator">Creator</a>
        <a href="/receipts">Receipts</a>
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
        {analytics.topWallet ? (
          <div className="pl-top-wallet">
            <span className="data-mono">{short(analytics.topWallet.address)}</span>
            <span>{analytics.topWallet.runs} runs</span>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
