"use client";

import { usePathname } from "next/navigation";

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
};

export default function SidebarPanel({ analytics }: Props) {
  const pathname = usePathname();

  return (
    <aside className="pl-sidebar">
      <div className="pl-brand">PayLabs</div>

      <nav className="pl-nav">
        <a className={pathname === "/" ? "active" : undefined} href="/">Chat</a>
        <a className={pathname === "/receipts" ? "active" : undefined} href="/receipts">Receipts</a>
        <a className={pathname === "/explorer" ? "active" : undefined} href="/explorer">Explorer</a>
        <a className={pathname === "/source" ? "active" : undefined} href="/source">Sources</a>
        <a className={pathname === "/creator-dashboard" ? "active" : undefined} href="/creator-dashboard">Creator Dashboard</a>
        <a className={pathname === "/creator-profile" ? "active" : undefined} href="/creator-profile">Creator Profile</a>
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
