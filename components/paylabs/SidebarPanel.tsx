"use client";

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
  topWallet?: { address: string; runs: number } | null;
};

type ExplorerRun = {
  id: string;
  route_tier: string | null;
  status: string | null;
  paid_edges: number;
  user_wallet: string | null;
  created_at: string | null;
};

type FeedItem = {
  id: string;
  title: string | null;
  publisher: string | null;
  author_name: string | null;
  canonical_url: string | null;
  is_monetized: boolean | null;
};

type Props = {
  analytics: Analytics;
  explorerRuns: ExplorerRun[];
  feedItems: FeedItem[];
};

function short(value?: string | null, chars = 6): string {
  if (!value) return "—";
  if (value.length <= chars * 2 + 3) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

function timeAgo(value?: string | null): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function SidebarPanel({ analytics, explorerRuns, feedItems }: Props) {
  return (
    <aside className="pl-sidebar">
      <div className="pl-brand">PayLabs</div>

      <nav className="pl-nav">
        <a className="active" href="/">Chat</a>
        <a href="/receipts">Receipts</a>
        <a href="/dashboard">Dashboard</a>
        <a href="/sources">Sources</a>
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

      {/* Global Explorer */}
      <section className="pl-side-card">
        <div className="pl-side-title">Global Explorer</div>
        <div className="pl-list">
          {explorerRuns.length === 0 ? (
            <div className="pl-empty">No runs yet</div>
          ) : (
            explorerRuns.map((run) => (
              <a
                key={run.id}
                href={`/dashboard?run=${run.id}`}
                className="pl-row"
              >
                <span className="pl-row-tier">{run.route_tier || "—"}</span>
                <span className="pl-row-edges">{run.paid_edges} edges</span>
                <span className="pl-row-time">{timeAgo(run.created_at)}</span>
              </a>
            ))
          )}
        </div>
      </section>

      {/* RSSHub Feed */}
      <section className="pl-side-card">
        <div className="pl-side-title">RSSHub Feed</div>
        <div className="pl-list">
          {feedItems.length === 0 ? (
            <div className="pl-empty">No feed items</div>
          ) : (
            feedItems.map((item) => (
              <a
                key={item.id}
                href={item.canonical_url || "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="pl-feed-row"
              >
                <b>{item.title || "Untitled"}</b>
                <div className="pl-feed-meta">
                  <span>{item.publisher || item.author_name || "Source"}</span>
                  {item.is_monetized ? (
                    <span className="badge badge-success" style={{ fontSize: 10 }}>Monetized</span>
                  ) : null}
                </div>
              </a>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
